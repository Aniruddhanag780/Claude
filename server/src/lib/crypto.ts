import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { restrictToOwner } from './file-permissions.js';
import type { Db } from '../db/types.js';

const ALGORITHM = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

/**
 * AES-256-GCM uses a 32-byte key, hex-encoded as 64 chars.
 * A typo'd ENCRYPTION_KEY (e.g. "abc") would historically fall through
 * the placeholder check, get truncated to 1.5 bytes, and only fail at
 * the first encrypt() call with a cryptic node:crypto error. Validate
 * the length up front and fail fast with an actionable message.
 */
const KEY_BYTES = 32;
const KEY_HEX_LEN = KEY_BYTES * 2;
const PLACEHOLDER_KEY = 'your-64-char-hex-key-here';

// Postgres has no local database file to keep the key beside (it lives on a
// remote server), so the dev-fallback key file sits at a stable location in the
// repository root instead. It is a separate artifact from the ciphertext it
// protects — never stored inside the database — and is chmod 0600 so it isn't
// world-readable.
//
// The path is derived from this module's own URL, not from process.cwd(), so it
// resolves identically under `src/` (tsx) and `dist/` (compiled) and does not
// change with the working directory. Three levels up from `server/src/lib` (or
// `server/dist/lib`) is the repository root.
const KEY_FILE_NAME = '.encryption-key';
const KEY_FILE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  KEY_FILE_NAME,
);

function parseHexKey(value: string, source: 'env' | 'db' | 'file'): Buffer {
  if (value.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(
      `Invalid ENCRYPTION_KEY (${source}): expected ${KEY_HEX_LEN} hex chars (32 bytes), got ${value.length} chars. ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return Buffer.from(value, 'hex');
}

// Outside production we auto-generate and persist a key so a fresh clone
// (`npm run dev`) boots without manual setup — the placeholder ENCRYPTION_KEY
// in .env.example would otherwise crash the server on boot, which surfaces in
// the client as "Can't reach the server". Production still requires an explicit
// env key: a generated key lives only on the local disk and silently losing it
// would make every stored API key undecryptable.
function isDevFallbackAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

function missingKeyError(): Error {
  return new Error(
    'ENCRYPTION_KEY is required in production for API key encryption. ' +
    `Set a ${KEY_HEX_LEN}-char hex key (generate one with: ` +
    `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"). ` +
    'Outside production a local key file is auto-generated next to the database.',
  );
}

// Write the hex key with a temp-file-and-rename so a crash never leaves a
// half-written key, and restrict it to the owner so it isn't readable by other
// local users. The temp file is restricted BEFORE the rename so the key is
// never briefly world-readable under its final name; a rename carries the DACL
// with it, and the second call is idempotent belt-and-braces.
function writeKeyFileAtomic(keyFile: string, hex: string): void {
  const dir = path.dirname(keyFile);
  const tmp = path.join(dir, `${KEY_FILE_NAME}.tmp-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, hex, { mode: 0o600 });
  restrictToOwner(tmp);
  fs.renameSync(tmp, keyFile);
  if (!restrictToOwner(keyFile)) {
    console.warn(`[crypto] could not restrict permissions on ${KEY_FILE_NAME} — it may be readable by other local accounts`);
  }
}

/**
 * Initialize encryption key from env or an explicit local-dev fallback.
 * Must be called after DB is initialized.
 *
 * Precedence (dev fallback): ENCRYPTION_KEY env > existing local key file >
 * legacy `settings` table row (migrated to the file, then deleted) >
 * freshly generated key written to the file.
 */
export async function initEncryptionKey(db: Db): Promise<void> {
  // 1. Explicit env key always wins.
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey && envKey !== PLACEHOLDER_KEY) {
    cachedKey = parseHexKey(envKey, 'env');
    return;
  }

  if (!isDevFallbackAllowed()) {
    throw missingKeyError();
  }

  const keyFile = KEY_FILE_PATH;

  // 2. An existing local dev key file.
  if (fs.existsSync(keyFile)) {
    const value = fs.readFileSync(keyFile, 'utf8').trim();
    cachedKey = parseHexKey(value, 'file');
    console.warn(`[crypto] No ENCRYPTION_KEY set — using the auto-generated key at ${keyFile} (dev only). Set ENCRYPTION_KEY for production.`);
    return;
  }

  // 3. A legacy key still sitting in the settings table (older installs).
  //    Migrate it to the key file so the DB stops storing the key that protects
  //    it, confirm a decrypt round-trip with the migrated key, then drop the row.
  const legacy = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'encryption_key'");
  if (legacy) {
    const migrated = parseHexKey(legacy.value, 'db');
    writeKeyFileAtomic(keyFile, migrated.toString('hex'));
    cachedKey = migrated;
    const probe = encrypt('roundtrip');
    if (decrypt(probe.encrypted, probe.iv, probe.authTag) !== 'roundtrip') {
      cachedKey = null;
      throw new Error('[crypto] Failed to migrate the DB-stored key to a key file: round-trip check failed.');
    }
    await db.run("DELETE FROM settings WHERE key = 'encryption_key'");
    console.warn(`[crypto] Migrated the legacy DB-stored key to ${keyFile} and removed it from the database (dev only). Set ENCRYPTION_KEY for production.`);
    return;
  }

  // 4. Generate a fresh key and persist it to the file.
  cachedKey = crypto.randomBytes(KEY_BYTES);
  writeKeyFileAtomic(keyFile, cachedKey.toString('hex'));
  console.warn(`[crypto] No ENCRYPTION_KEY set — generated a local dev key at ${keyFile}. Set ENCRYPTION_KEY for production.`);
}

function getEncryptionKey(): Buffer {
  if (!cachedKey) {
    throw new Error('Encryption key not initialized. Call initEncryptionKey() first.');
  }
  return cachedKey;
}

/**
 * A short, non-reversible identifier for the key currently in use.
 *
 * Database dumps record it in their header so a restore can tell, before it
 * touches a row, whether the api_keys ciphertext in the file was written under
 * this key. sha256 truncated to 64 bits: enough to catch a different key,
 * nowhere near enough to help recover the key itself, and safe to show in an
 * error message or write to a file an operator emails around.
 *
 * Returns null before initEncryptionKey() has run.
 */
export function encryptionKeyFingerprint(): string | null {
  if (!cachedKey) return null;
  return `sha256:${crypto.createHash('sha256').update(cachedKey).digest('hex').slice(0, 16)}`;
}

export function isEncryptionKeyInitialized(): boolean {
  return cachedKey !== null;
}

export function encrypt(text: string): { encrypted: string; iv: string; authTag: string } {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag,
  };
}

// AUTH_TAG_BYTES pins the GCM tag length to 16 bytes. Without this option Node
// will accept any tag of length 4–16 bytes (RFC 5116 §3.2), which lets anyone
// who can rewrite a row in `api_keys` swap in a 4-byte tag and start brute-
// forcing forgeries at 2^32 attempts. Pinning closes that truncation path.
const AUTH_TAG_BYTES = 16;

export function decrypt(encrypted: string, iv: string, authTag: string): string {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'), { authTagLength: AUTH_TAG_BYTES });
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// A masked key is display-only — it feeds the `maskedKey` field every key,
// media, embedding and client-profile route hands to the dashboard — so it must
// never be enough to reconstruct the secret. The old short-key branch was
// `'****' + key.slice(-4)`, and slice(-4) keeps the last four characters no
// matter how short the input is: a 4-character key was echoed back IN FULL, and
// a 5-character key gave away 4 of its 5 characters. Short keys are not
// hypothetical — proxy credentials, self-hosted Ollama tokens and local dev
// keys all land here.
//
// So reveal nothing at all below 5 characters, and at most the last TWO up to
// 8: enough tail to tell two rows apart in the UI, not enough to be a
// meaningful share of the secret. Long keys keep the familiar prefix+suffix
// form, where 8 revealed characters out of 20+ is a fixed, small fraction.
export function maskKey(key: string): string {
  if (key.length < 5) return '****';
  if (key.length <= 8) return '****' + key.slice(-2);
  return key.slice(0, 4) + '...' + key.slice(-4);
}
