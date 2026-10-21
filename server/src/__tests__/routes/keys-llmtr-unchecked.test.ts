import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { up as reenableLlmtrKeys, down as undoReenableLlmtrKeys } from '../../db/migrations/20261017_000001_llmtr_reenable_keys.js';
import { initTestDb } from '../helpers/test-db.js';

// #1459 follow-up: an LLMTR key the pre-v0.13.3 probe auto-disabled stayed
// switched off forever, and editing in a fresh key left it off, so it could
// never serve the first request that now marks an LLMTR key healthy.

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('LLMTR keys stuck off and unchecked (#1459)', () => {
  let app: Express;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
    app = createApp();
    dashToken = await mintDashboardToken();
  });

  beforeEach(async () => {
    (await getDb().run('DELETE FROM api_keys'));
  });

  async function addKey(platform: string, key: string): Promise<number> {
    const { body } = await request(app, 'POST', '/api/keys', { platform, key, label: platform });
    return body.id as number;
  }

  const row = async (id: number) =>
    (await getDb().get('SELECT enabled, status, last_health_error FROM api_keys WHERE id = ?', [id])) as any;

  it('pasting in a new key switches an auto-disabled key back on', async () => {
    const id = await addKey('llmtr', 'llmt.oldkey1234567890');
    (await getDb().run("UPDATE api_keys SET enabled = 0, status = 'invalid', last_health_error = 'old probe' WHERE id = ?", [id]));

    const { status } = await request(app, 'PATCH', `/api/keys/${id}`, { key: 'llmt.newkey1234567890' });

    expect(status).toBe(200);
    expect(await row(id)).toEqual({ enabled: 1, status: 'unknown', last_health_error: null });
  });

  it('an explicit enabled:false in the same edit still wins', async () => {
    const id = await addKey('groq', 'gsk_oldkeyvalue123456');
    await request(app, 'PATCH', `/api/keys/${id}`, { key: 'gsk_newkeyvalue123456', enabled: false });
    expect((await row(id)).enabled).toBe(0);
  });

  it('saving the same key value does not flip a switched-off key on', async () => {
    const id = await addKey('groq', 'gsk_samekeyvalue12345');
    (await getDb().run('UPDATE api_keys SET enabled = 0 WHERE id = ?', [id]));
    await request(app, 'PATCH', `/api/keys/${id}`, { key: 'gsk_samekeyvalue12345', label: 'renamed' });
    expect((await row(id)).enabled).toBe(0);
  });

  it('the key list tells the dashboard which keys are never auto-checked', async () => {
    const llmtr = await addKey('llmtr', 'llmt.listkey123456789');
    const groq = await addKey('groq', 'gsk_listkeyvalue12345');
    const { body } = await request(app, 'GET', '/api/keys');
    const byId = new Map(body.map((k: any) => [k.id, k]));
    expect(byId.get(llmtr)).toMatchObject({ autoHealthCheck: false, modelsAvailable: expect.any(Number) });
    expect(byId.get(groq)).toMatchObject({ autoHealthCheck: true });
    expect(byId.get(groq)).not.toHaveProperty('modelsAvailable');
  });
});

describe('migration 20261017_000001_llmtr_reenable_keys', () => {
  it('switches back on only LLMTR keys that are off and marked invalid', async () => {
    // PG: the migration is exercised against the real schema on this file's
    // test database (the old scratch SQLite DB with hand-built columns is
    // gone). Only the columns the migration reads or writes are set.
    const db = getDb();
    (await db.run('DELETE FROM api_keys'));
    const seedRow = (id: number, platform: string, enabled: number, status: string, err: string | null) =>
      db.run(`INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, status, enabled, last_health_error)
              VALUES (?, ?, '', 'enc', 'iv', 'tag', ?, ?, ?) RETURNING id`, [id, platform, status, enabled, err]);
    await seedRow(1, 'llmtr', 0, 'invalid', 'HTTP 403 automated validation');
    await seedRow(2, 'llmtr', 0, 'healthy', null);   // operator switched it off
    await seedRow(3, 'llmtr', 0, 'unknown', null);   // operator switched it off
    await seedRow(4, 'groq', 0, 'invalid', 'bad key'); // a genuinely bad key elsewhere
    await seedRow(5, 'llmtr', 1, 'healthy', null);

    await reenableLlmtrKeys(db as any);

    const rows = (await db.all('SELECT id, enabled, status, last_health_error FROM api_keys ORDER BY id'));
    expect(rows).toEqual([
      { id: 1, enabled: 1, status: 'unknown', last_health_error: null },
      { id: 2, enabled: 0, status: 'healthy', last_health_error: null },
      { id: 3, enabled: 0, status: 'unknown', last_health_error: null },
      { id: 4, enabled: 0, status: 'invalid', last_health_error: 'bad key' },
      { id: 5, enabled: 1, status: 'healthy', last_health_error: null },
    ]);

    // down switches exactly that key off again
    await undoReenableLlmtrKeys(db as any);
    expect((await db.get('SELECT enabled, status FROM api_keys WHERE id = 1'))).toEqual({ enabled: 0, status: 'invalid' });
    expect((await db.get('SELECT enabled FROM api_keys WHERE id = 5'))).toEqual({ enabled: 1 });
  });
});
