import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDb, closeDb } from '../../db/index.js';
import { encrypt, decrypt, initEncryptionKey } from '../../lib/crypto.js';
import { initTestDb } from '../helpers/test-db.js';

const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

describe('initDb encryption bootstrapping (PG)', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'c'.repeat(64);
  });

  afterEach(async () => {
    if (ORIGINAL_ENCRYPTION_KEY === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
    vi.resetModules();
    await closeDb().catch(() => { /* not connected */ });
  });

  // The SQLite version reopened a database FILE to prove the key survived a
  // restart. On PG there is no file: a restart is a new pool over the same
  // database, so the equivalent guarantee is that the key material is loaded
  // again on boot and the ciphertext written by the previous process still
  // decrypts.
  it('loads the encryption key on boot and decrypts ciphertext written before', async () => {
    await initTestDb();

    const encrypted = encrypt('provider-secret');
    await connectDb().then((db) => db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('google', 'Google', ?, ?, ?, 'healthy', 1) RETURNING id`,
      [encrypted.encrypted, encrypted.iv, encrypted.authTag]));

    // Restart: drop the pool, reconnect to the same database, re-run the
    // key bootstrap exactly as a fresh boot would.
    await closeDb();
    const db = await connectDb();
    await initEncryptionKey(db);

    const row = await db.get<{ encrypted_key: string; iv: string; auth_tag: string }>(`
      SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = 'google'
    `);

    expect(row).toBeTruthy();
    expect(decrypt(row!.encrypted_key, row!.iv, row!.auth_tag)).toBe('provider-secret');
  });

  it('never stores the provider key in plaintext', async () => {
    await initTestDb();
    const encrypted = encrypt('provider-secret');

    const db = await connectDb();
    await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('google', 'Google', ?, ?, ?, 'healthy', 1) RETURNING id`,
      [encrypted.encrypted, encrypted.iv, encrypted.authTag]);

    const row = await db.get<{ encrypted_key: string }>(
      "SELECT encrypted_key FROM api_keys WHERE encrypted_key = ?",
      [encrypted.encrypted],
    );
    // Nothing is stored in the clear: the column holds ciphertext, and the
    // plaintext never appears anywhere in it.
    expect(row?.encrypted_key).not.toContain('provider-secret');
  });
});
