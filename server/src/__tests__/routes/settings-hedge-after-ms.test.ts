import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getSetting } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { HEDGE_AFTER_MS_SETTING, HEDGE_AFTER_MS_MAX } from '../../lib/fallback-loop.js';

// #1347 (PR 3): GET/PUT /api/settings/hedge-after-ms — the dashboard knob for
// hedged racing (ms of first-candidate silence before the next candidate is
// started in parallel). Off (null) by default; the ROUTER_HEDGE_AFTER_MS env
// var pins the effective value over this stored one.
async function request(app: Express, method: string, path: string, body: any, token: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json };
}

describe('/api/settings/hedge-after-ms (#1347 PR 3)', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  beforeEach(() => {
    delete process.env.ROUTER_HEDGE_AFTER_MS;
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(HEDGE_AFTER_MS_SETTING);
  });

  afterEach(() => {
    delete process.env.ROUTER_HEDGE_AFTER_MS;
  });

  it('reports null (off) before anything is configured', async () => {
    const { status, body } = await request(app, 'GET', '/api/settings/hedge-after-ms', undefined, token);
    expect(status).toBe(200);
    expect(body).toEqual({ ms: null });
  });

  it('sets, reports, and clears the threshold', async () => {
    const put = await request(app, 'PUT', '/api/settings/hedge-after-ms', { ms: 2500 }, token);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ ms: 2500 });
    expect(getSetting(HEDGE_AFTER_MS_SETTING)).toBe('2500');

    const get = await request(app, 'GET', '/api/settings/hedge-after-ms', undefined, token);
    expect(get.body).toEqual({ ms: 2500 });

    const clear = await request(app, 'PUT', '/api/settings/hedge-after-ms', { ms: null }, token);
    expect(clear.body).toEqual({ ms: null });
    expect(getSetting(HEDGE_AFTER_MS_SETTING)).toBeUndefined();
  });

  it('rejects malformed bodies', async () => {
    for (const body of [{ ms: 'abc' }, { ms: -1 }, { ms: HEDGE_AFTER_MS_MAX + 1 }, { ms: 1.5 }, {}]) {
      const { status } = await request(app, 'PUT', '/api/settings/hedge-after-ms', body, token);
      expect(status).toBe(400);
    }
  });

  it('the env pin does not write back to the dashboard value', async () => {
    process.env.ROUTER_HEDGE_AFTER_MS = '100';
    const get = await request(app, 'GET', '/api/settings/hedge-after-ms', undefined, token);
    // Stored value stays null — the effective value (100) is resolved by the
    // loop, and the dashboard hint explains the pin.
    expect(get.body).toEqual({ ms: null });
  });
});
