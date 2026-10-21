import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { initTestDb } from '../helpers/test-db.js';

async function get(app: Express, path: string, token: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  server.close();
  return { status: response.status, body: body as any };
}

describe('GET /api/analytics/by-client', () => {
  let app: Express;
  let token: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
    app = createApp();
    token = await mintDashboardToken();
  });

  beforeEach(async () => {
    await getDb().run('DELETE FROM requests');
    await getDb().run(`
      INSERT INTO requests
        (platform, model_id, status, input_tokens, output_tokens, latency_ms, client_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, ['groq', 'coder', 'success', 10, 5, 100, 'claude-code']);
    await getDb().run(`
      INSERT INTO requests
        (platform, model_id, status, input_tokens, output_tokens, latency_ms, client_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, ['groq', 'coder', 'error', 8, 0, 300, 'claude-code']);
    await getDb().run(`
      INSERT INTO requests
        (platform, model_id, status, input_tokens, output_tokens, latency_ms, client_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, ['google', 'flash', 'success', 4, 2, 80, 'gemini-cli']);
  });

  it('groups request volume and success by detected agent', async () => {
    const response = await get(app, '/api/analytics/by-client?range=7d', token);
    expect(response.status).toBe(200);
    expect(response.body[0]).toMatchObject({
      clientAgent: 'claude-code',
      requests: 2,
      successRate: 50,
      avgLatencyMs: 200,
    });
    expect(response.body[1]).toMatchObject({
      clientAgent: 'gemini-cli',
      requests: 1,
      successRate: 100,
    });
  });
});
