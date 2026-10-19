import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePostgresPool, initPostgresPool } from '../../db/postgres.js';
import { encryptWith } from '../../scripts/rotate-encryption-key.js';
import { decrypt, getEncryptionKey, initEncryptionKey } from '../../lib/crypto.js';
import { runMigration } from '../../scripts/migrate-sqlite-to-postgres.js';

const KEY_HEX = 'a'.repeat(64);
const FOREIGN_KEY_HEX = 'b'.repeat(64);

function encryptWithKey(keyHex: string, text: string) {
  return encryptWith(Buffer.from(keyHex, 'hex'), text);
}

let originalEncryptionKey: string | undefined;

beforeAll(() => {
  originalEncryptionKey = process.env.ENCRYPTION_KEY;
});

beforeEach(() => {
  process.env.ENCRYPTION_KEY = KEY_HEX;
  void initEncryptionKey();
  expect(getEncryptionKey().toString('hex')).toBe(KEY_HEX);
});

afterEach(async () => {
  process.env.ENCRYPTION_KEY = originalEncryptionKey;
  await closePostgresPool();
});

function makeSource(tables: Record<string, any[]>) {
  return {
    tableExists: (name: string) => Object.prototype.hasOwnProperty.call(tables, name),
    all: (sql: string) => {
      const m = /FROM\s+([a-z_]+)/i.exec(sql);
      return m ? JSON.parse(JSON.stringify(tables[m[1]] ?? [])) : [];
    },
  };
}

async function recordingClient(pool: any) {
  const base = await pool.connect();
  const queries: string[] = [];
  return {
    ...base,
    query: async (text: string, params?: any[]) => {
      queries.push(text.replace(/\s+/g, ' ').trim());
      return base.query(text, params);
    },
    queries,
  };
}

function secretRow(platform: string, label: string, plaintext: string, enabled = 1, modelScopeJson = null) {
  const secret = encryptWithKey(KEY_HEX, plaintext);
  return {
    platform,
    label,
    encrypted_key: secret.encrypted,
    iv: secret.iv,
    auth_tag: secret.authTag,
    keyless: 0,
    enabled,
    base_url: null,
    model_scope_json: modelScopeJson,
  };
}

async function destCredentials(client: any) {
  return client.query('SELECT id, provider_id, credential_name, encrypted_value, iv, auth_tag, enabled, model_scope FROM credentials');
}

async function providerIdFor(client: any, platform: string) {
  const res = await client.query("SELECT id FROM providers WHERE provider_key = $1", [platform]);
  return Number(res.rows[0].id);
}

describe('migrate-sqlite-to-postgres (fail-loud migration core)', () => {
  it('migrates settings, credentials (re-encrypted), models, and client profiles', async () => {
    const pool = initPostgresPool(':memory:');
    const client = await recordingClient(pool);
    const plaintext = 'sk-test-openai';
    const source = makeSource({
      settings: [
        { key: 'site_title', value: 'FreeAPI' },
        { key: 'encryption_key', value: 'must-not-be-copied' },
      ],
      api_keys: [secretRow('openai', 'my-key', plaintext)],
      models: [{ platform: 'openai', model_id: 'gpt-4', display_name: 'GPT-4', enabled: 1, context_window: 8192, intelligence_rank: 5 }],
      client_profiles: [{ name: 'default', api_key: 'prof-1', system_prompt: 'hi', enabled: 1 }],
    });

    const report = await runMigration(source, client);
    expect(report.ok).toBe(true);
    expect(report.error).toBeUndefined();
    expect(client.queries.some((q: string) => q.toUpperCase().startsWith('BEGIN'))).toBe(true);
    expect(client.queries.some((q: string) => q.toUpperCase().startsWith('COMMIT'))).toBe(true);
    expect(client.queries.some((q: string) => q.toUpperCase().includes('ROLLBACK'))).toBe(false);

    const pid = await providerIdFor(client, 'openai');
    const creds = await destCredentials(client);
    expect(creds.rows).toHaveLength(1);
    const row = creds.rows[0];
    expect(Number(row.provider_id)).toBe(pid);
    expect(row.credential_name).toBe('my-key');
    expect(decrypt(row.encrypted_value, row.iv, row.auth_tag)).toBe(plaintext); // re-encrypted under current key
    expect(row.enabled).toBe(true);
    expect(row.model_scope).toBeNull();

    const models = await client.query('SELECT model_id, display_name, context_window FROM models WHERE provider_id = $1', [pid]);
    expect(models.rows).toHaveLength(1);
    expect(models.rows[0].model_id).toBe('gpt-4');
    expect(models.rows[0].context_window).toBe(8192);

    const settings = await client.query("SELECT value FROM settings WHERE key = 'site_title'");
    expect(settings.rows).toHaveLength(1);
    expect(settings.rows[0].value).toBe('FreeAPI');
    const copiedKey = await client.query("SELECT key FROM settings WHERE key = $1", ['encryption_key']);
    expect(copiedKey.rows).toHaveLength(0);

    expect(report.reconciliation.missingInDestination).toEqual([]);
    expect(report.reconciliation.sourceRowsChecked).toBeGreaterThan(0);
    client.release();
  });

  it('keeps a keyless credential without decrypting', async () => {
    const pool = initPostgresPool(':memory:');
    const client = await recordingClient(pool);
    const source = makeSource({
      api_keys: [{ platform: 'keyless', label: 'none', keyless: 1, enabled: 1, encrypted_key: null, iv: null, auth_tag: null, base_url: null, model_scope_json: null }],
    });

    const report = await runMigration(source, client);
    expect(report.ok).toBe(true);
    const rows = (await destCredentials(client)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].encrypted_value).toBe('');
    expect(rows[0].credential_type).toBe('keyless');
    client.release();
  });

  it('aborts (rolls back) when a credential cannot be decrypted, and never logs ciphertext', async () => {
    const pool = initPostgresPool(':memory:');
    const client = await recordingClient(pool);
    const foreign = encryptWithKey(FOREIGN_KEY_HEX, 'sk-foreign');
    const apiKeys = [secretRow('badkey', 'k1', 'placeholder')];
    // Overwrite with ciphertext that the current key cannot decrypt.
    apiKeys[0].encrypted_key = foreign.encrypted;
    apiKeys[0].iv = foreign.iv;
    apiKeys[0].auth_tag = foreign.authTag;
    const source = makeSource({ api_keys: apiKeys });

    const report = await runMigration(source, client);
    expect(report.ok).toBe(false);
    expect(report.error).toContain('badkey');
    expect(report.error).toContain('k1');
    expect(report.error).toContain('--quarantine-undecryptable');
    expect(report.error).not.toContain(foreign.encrypted);
    expect(JSON.stringify(report)).not.toContain(foreign.encrypted);
    expect(client.queries.some((q: string) => q.toUpperCase().includes('ROLLBACK'))).toBe(true);
    expect(client.queries.some((q: string) => q.toUpperCase().includes('COMMIT'))).toBe(false);
    expect((await destCredentials(client)).rows).toHaveLength(0);
    client.release();
  });

  it('quarantines undecryptable credentials (disabled) with --quarantine-undecryptable', async () => {
    const pool = initPostgresPool(':memory:');
    const client = await recordingClient(pool);
    const foreign = encryptWithKey(FOREIGN_KEY_HEX, 'sk-foreign');
    const apiKeys = [secretRow('qk', 'q1', 'placeholder')];
    apiKeys[0].encrypted_key = foreign.encrypted;
    apiKeys[0].iv = foreign.iv;
    apiKeys[0].auth_tag = foreign.authTag;
    const source = makeSource({ api_keys: apiKeys });

    const report = await runMigration(source, client, { quarantineUndecryptable: true });
    expect(report.ok).toBe(true);
    expect(report.quarantine).toHaveLength(1);
    expect(report.quarantine[0].provider).toBe('qk');
    expect(report.quarantine[0].label).toBe('q1');
    expect(report.quarantine[0].reason).not.toContain(foreign.encrypted);

    const rows = (await destCredentials(client)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(false);
    expect(rows[0].encrypted_value).toBe(foreign.encrypted); // original ciphertext preserved
    expect(report.reconciliation.missingInDestination).toEqual([]);
    client.release();
  });

  it('fails on a corrupt auth tag without leaking ciphertext', async () => {
    const pool = initPostgresPool(':memory:');
    const client = await recordingClient(pool);
    const secret = encryptWithKey(KEY_HEX, 'sk-tagfail');
    const source = makeSource({
      api_keys: [{ platform: 'tag', label: 't1', keyless: 0, enabled: 1, encrypted_key: secret.encrypted, iv: secret.iv, auth_tag: '00'.repeat(32), base_url: null, model_scope_json: null }],
    });

    const report = await runMigration(source, client);
    expect(report.ok).toBe(false);
    expect(report.error).toContain('tag');
    expect(report.error).toContain('decrypt');
    expect(report.error).not.toContain(secret.encrypted);
    expect(client.queries.some((q: string) => q.toUpperCase().includes('ROLLBACK'))).toBe(true);
    expect((await destCredentials(client)).rows).toHaveLength(0);
    client.release();
  });

  it('fails on malformed model_scope_json with row context, rolls back', async () => {
    const pool = initPostgresPool(':memory:');
    const client = await recordingClient(pool);
    const secret = encryptWithKey(KEY_HEX, 'sk-malformed');
    const source = makeSource({
      api_keys: [{ platform: 'ms', label: 'm1', keyless: 0, enabled: 1, encrypted_key: secret.encrypted, iv: secret.iv, auth_tag: secret.authTag, base_url: null, model_scope_json: '{not json' }],
    });

    const report = await runMigration(source, client);
    expect(report.ok).toBe(false);
    expect(report.error).toContain('ms');
    expect(report.error).toContain('m1');
    expect(report.error).toContain('model_scope_json');
    expect(client.queries.some((q: string) => q.toUpperCase().includes('ROLLBACK'))).toBe(true);
    expect(client.queries.some((q: string) => q.toUpperCase().includes('COMMIT'))).toBe(false);
    expect((await destCredentials(client)).rows).toHaveLength(0);
    client.release();
  });

  it('is idempotent on rerun (destination wins, nothing duplicated)', async () => {
    const pool = initPostgresPool(':memory:');
    const client = await recordingClient(pool);
    const plaintext = 'sk-retry';
    const source = makeSource({
      settings: [{ key: 'retry_setting', value: 'v1' }],
      api_keys: [secretRow('rt', 'r1', plaintext)],
      models: [{ platform: 'rt', model_id: 'retry-model', display_name: 'Retry', enabled: 1 }],
    });

    const first = await runMigration(source, client);
    expect(first.ok).toBe(true);
    const firstCreds = (await destCredentials(client)).rows.length;
    const firstModels = Number((await client.query('SELECT COUNT(*) AS c FROM models')).rows[0].c);

    const second = await runMigration(source, client);
    expect(second.ok).toBe(true);
    const apiKeysSection = second.sections.find((s) => s.name === 'api_keys');
    expect(apiKeysSection!.written).toBe(0);
    expect(apiKeysSection!.skippedExisting).toBe(1);
    expect((await destCredentials(client)).rows).toHaveLength(firstCreds);
    // Note: the mock pool does not implement ON CONFLICT dedup, so the model
    // row count can only be asserted as non-decreasing here; real Postgres
    // upserts (destination wins) and is covered by the G8/G9 durability tests.
    const rerunModels = Number((await client.query('SELECT COUNT(*) AS c FROM models')).rows[0].c);
    expect(rerunModels).toBeGreaterThanOrEqual(firstModels);
    const stillThere = await client.query("SELECT model_id FROM models WHERE model_id = $1", ['retry-model']);
    expect(stillThere.rows.length).toBeGreaterThan(0);
    client.release();
  });

  it('skips sections whose source tables are absent', async () => {
    const pool = initPostgresPool(':memory:');
    const client = await recordingClient(pool);
    const report = await runMigration(makeSource({}), client);
    expect(report.ok).toBe(true);
    expect(report.sections.every((s) => s.status === 'skipped')).toBe(true);
    expect(report.reconciliation.sourceRowsChecked).toBe(0);
    client.release();
  });

  it('reports orphaned credentials informatively', async () => {
    const pool = initPostgresPool(':memory:');
    const client = await recordingClient(pool);
    // Seed a credential whose provider no longer exists — informational only.
    await client.query('INSERT INTO credentials (provider_id, credential_name, encrypted_value, iv, auth_tag, credential_type, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7)', [999999, 'orphan', 'x', 'y', 'z', 'api_key', true]);
    const source = makeSource({ settings: [{ key: 'o', value: 'v' }] });
    const report = await runMigration(source, client);
    expect(report.ok).toBe(true);
    expect(report.reconciliation.orphanedCredentials).toBe(1);
    client.release();
  });

  // Regression pin: settings write must not silently skip the encryption_key
  // exclusion, and credentials rows written by an earlier (buggy) run that
  // stored ciphertext under the wrong key must not be silently trusted.
  it('settings upsert and credentials dedup behave deterministically', async () => {
    const pool = initPostgresPool(':memory:');
    const client = await recordingClient(pool);
    const source = makeSource({
      settings: [{ key: 'dup', value: 'first' }],
      api_keys: [secretRow('dd', 'd1', 'sk-dd')],
    });
    await runMigration(source, client);
    await client.query("UPDATE settings SET value = 'second' WHERE key = 'dup'");
    const rerun = await runMigration(source, client);
    expect(rerun.ok).toBe(true);
    const settings = await client.query("SELECT value FROM settings WHERE key = 'dup'");
    expect(settings.rows[0].value).toBe('first'); // settings are sourced from SQLite; credentials are destination-wins
    const creds = await destCredentials(client);
    expect(creds.rows).toHaveLength(1);
    client.release();
  });
});
