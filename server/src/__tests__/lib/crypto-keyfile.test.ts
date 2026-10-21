import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import type { Db } from '../../db/types.js';
import fs from 'fs';
import path from 'path';
import { initTestDb } from '../helpers/test-db.js';
import { initEncryptionKey, encrypt, decrypt } from '../../lib/crypto.js';
import { aclEntries } from '../helpers/acl.js';

// FIX 2: the dev-fallback key is persisted to a fixed local file, not into the
// `settings` table it protects. PG adaptation: the old "file next to the DB"
// is now the repo-root `.encryption-key` (see KEY_FILE_PATH in lib/crypto.ts —
// derived from the module URL, three levels up from server/src/lib). These
// tests therefore BACK UP whatever key file exists on this machine and restore
// it afterwards — they must never clobber a developer's real dev key.

const KEY_FILE = path.resolve(process.cwd(), '..', '.encryption-key');

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

let keyFileBackup: { existed: boolean; content?: string };

function restoreEnv() {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_ENCRYPTION_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
}

let db: Db;

describe('initEncryptionKey — key file (dev fallback)', () => {
  beforeAll(() => {
    keyFileBackup = fs.existsSync(KEY_FILE)
      ? { existed: true, content: fs.readFileSync(KEY_FILE, 'utf8') }
      : { existed: false };
  });

  beforeEach(async () => {
    restoreEnv();
    delete process.env.ENCRYPTION_KEY;
    process.env.NODE_ENV = 'test';
    // Each test starts from "no key file on disk" (like the old fresh temp dir).
    fs.rmSync(KEY_FILE, { force: true });
    db = await initTestDb();
  });

  afterEach(() => {
    fs.rmSync(KEY_FILE, { force: true });
    restoreEnv();
  });

  afterAll(() => {
    if (keyFileBackup.existed) fs.writeFileSync(KEY_FILE, keyFileBackup.content!, { mode: 0o600 });
    else fs.rmSync(KEY_FILE, { force: true });
  });

  it('generates a fresh key into the key file, not the settings table', async () => {
    await initEncryptionKey(db);

    expect(fs.existsSync(KEY_FILE)).toBe(true);
    expect(fs.readFileSync(KEY_FILE, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
    // The key must NOT be stored in the DB it protects.
    expect((await db.get("SELECT value FROM settings WHERE key = 'encryption_key'"))).toBeUndefined();
    // The generated key actually works.
    const enc = encrypt('hello');
    expect(decrypt(enc.encrypted, enc.iv, enc.authTag)).toBe('hello');

    // The master key must be owner-only. Each platform asserts what it can
    // actually enforce: POSIX modes on POSIX, the NTFS ACL on Windows, where
    // chmod cannot express this at all.
    if (process.platform !== 'win32') {
      expect(fs.statSync(KEY_FILE).mode & 0o777).toBe(0o600);
    } else {
      expect(aclEntries(KEY_FILE).filter(e => e.includes('(I)'))).toEqual([]);
    }
  });

  it('reuses an existing key file on the next boot', async () => {
    await initEncryptionKey(db);
    const firstKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
    const enc = encrypt('provider-secret');

    // Second boot (fresh module state simulated by calling init again).
    await initEncryptionKey(db);
    expect(fs.readFileSync(KEY_FILE, 'utf8').trim()).toBe(firstKey);
    // Ciphertext from the first boot still decrypts under the reused key.
    expect(decrypt(enc.encrypted, enc.iv, enc.authTag)).toBe('provider-secret');
  });

  it('migrates a legacy settings-table key to the file and still decrypts', async () => {
    const K = 'd'.repeat(64);
    // Encrypt a secret under K via the env path (how an old install's data was
    // written), then simulate that install: key in settings, no env, no file.
    process.env.ENCRYPTION_KEY = K;
    await initEncryptionKey(db);
    const secret = 'sk-legacy-secret';
    const ciphertext = encrypt(secret);

    delete process.env.ENCRYPTION_KEY;
    process.env.NODE_ENV = 'test';
    (await db.run("INSERT INTO settings (key, value) VALUES ('encryption_key', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [K]));
    expect(fs.existsSync(KEY_FILE)).toBe(false);

    await initEncryptionKey(db);

    // Key moved to the file, with the same bytes.
    expect(fs.readFileSync(KEY_FILE, 'utf8').trim()).toBe(K);
    // And removed from the DB.
    expect((await db.get("SELECT value FROM settings WHERE key = 'encryption_key'"))).toBeUndefined();
    // Existing ciphertext still decrypts seamlessly.
    expect(decrypt(ciphertext.encrypted, ciphertext.iv, ciphertext.authTag)).toBe(secret);
  });

  it('prefers the ENCRYPTION_KEY env over an existing key file', async () => {
    fs.writeFileSync(KEY_FILE, 'a'.repeat(64), { mode: 0o600 });

    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    await initEncryptionKey(db);
    const encUnderEnv = encrypt('x');

    // The file was not consulted and is left untouched.
    expect(fs.readFileSync(KEY_FILE, 'utf8').trim()).toBe('a'.repeat(64));

    // Prove env != file: re-init without env now loads the (different) file key,
    // so ciphertext produced under the env key can no longer be decrypted.
    delete process.env.ENCRYPTION_KEY;
    await initEncryptionKey(db);
    expect(() => decrypt(encUnderEnv.encrypted, encUnderEnv.iv, encUnderEnv.authTag)).toThrow();
  });
});
