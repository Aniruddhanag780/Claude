import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Db } from '../../db/types.js';
import { initTestDb } from '../helpers/test-db.js';
import { initEncryptionKey, encrypt, decrypt } from '../../lib/crypto.js';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function restoreEnv() {
  delete process.env.ENCRYPTION_KEY;
  delete process.env.DEV_MODE;
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
}

/** Per-test database (the PG equivalent of the old throwaway `new Database(':memory:')`). */
let db: Db;

describe('initEncryptionKey — input validation', () => {
  beforeEach(async () => {
    restoreEnv();
    db = await initTestDb();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('accepts a valid 64-char hex env key', async () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    await initEncryptionKey(db);
    // Round-trip a value to confirm the key actually works.
    const enc = encrypt('hello');
    expect(decrypt(enc.encrypted, enc.iv, enc.authTag)).toBe('hello');
  });

  it('throws on too-short env key (typo guard)', async () => {
    process.env.ENCRYPTION_KEY = 'abc';
    await expect(await initEncryptionKey(db)).rejects.toThrow(/Invalid ENCRYPTION_KEY \(env\).+expected 64 hex chars/);
  });

  it('throws on too-long env key', async () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(80);
    await expect(await initEncryptionKey(db)).rejects.toThrow(/Invalid ENCRYPTION_KEY \(env\)/);
  });

  it('throws on non-hex env key of correct length', async () => {
    process.env.ENCRYPTION_KEY = 'g'.repeat(64); // g is not hex
    await expect(await initEncryptionKey(db)).rejects.toThrow(/Invalid ENCRYPTION_KEY \(env\)/);
  });

  it('auto-generates and persists a key outside production when ENCRYPTION_KEY is unset', async () => {
    process.env.NODE_ENV = 'test';
    (await db.run("DELETE FROM settings WHERE key = 'encryption_key'")); // harness seeded one
    await initEncryptionKey(db);
    const row = (await db.get("SELECT value FROM settings WHERE key = 'encryption_key'")) as { value: string };
    expect(row.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('loads an existing DB-stored fallback key outside production', async () => {
    process.env.NODE_ENV = 'test';
    (await db.run("INSERT INTO settings (key, value) VALUES ('encryption_key', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", ['b'.repeat(64)]));
    await initEncryptionKey(db);
    // The existing key is reused, not overwritten.
    const row = (await db.get("SELECT value FROM settings WHERE key = 'encryption_key'")) as { value: string };
    expect(row.value).toBe('b'.repeat(64));
  });

  it('requires ENCRYPTION_KEY in production and never persists a fallback key', async () => {
    process.env.NODE_ENV = 'production';
    (await db.run("DELETE FROM settings WHERE key = 'encryption_key'")); // harness seeded one
    await expect(await initEncryptionKey(db)).rejects.toThrow(/ENCRYPTION_KEY is required/);
    const row = (await db.get("SELECT value FROM settings WHERE key = 'encryption_key'"));
    expect(row).toBeUndefined();
  });

  it('does not load a DB-stored fallback key in production', async () => {
    process.env.NODE_ENV = 'production';
    (await db.run("INSERT INTO settings (key, value) VALUES ('encryption_key', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", ['b'.repeat(64)]));
    await expect(await initEncryptionKey(db)).rejects.toThrow(/ENCRYPTION_KEY is required/);
  });

  it('treats the placeholder as "not set" and auto-generates outside production', async () => {
    process.env.ENCRYPTION_KEY = 'your-64-char-hex-key-here';
    process.env.NODE_ENV = 'test';
    (await db.run("DELETE FROM settings WHERE key = 'encryption_key'")); // harness seeded one
    await initEncryptionKey(db);
    const row = (await db.get("SELECT value FROM settings WHERE key = 'encryption_key'")) as { value: string };
    expect(row.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws on a corrupted DB-stored key', async () => {
    process.env.NODE_ENV = 'test';
    (await db.run("INSERT INTO settings (key, value) VALUES ('encryption_key', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", ['not-hex']));
    await expect(await initEncryptionKey(db)).rejects.toThrow(/Invalid ENCRYPTION_KEY \(db\)/);
  });
});
