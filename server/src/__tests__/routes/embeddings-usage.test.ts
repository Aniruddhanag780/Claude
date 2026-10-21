import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { initTestDb } from '../helpers/test-db.js';

// GET /api/embeddings/usage backs the month-to-date card on the Embeddings tab.
// The response gained `platform`, `quotaLabel` and the two totals; the three
// original per-family fields are load-bearing for the family rows and must keep
// their shape. There is deliberately no budget field — embedding_models carries
// only a free-text quota_label, so a percentage would have to be invented.

let dashToken = '';

async function get(app: Express, path: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    headers: isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {},
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

async function seedFamily(family: string, platform: string, modelId: string, priority: number, quota: string, enabled = 1) {
  (await getDb().run(`
    INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled, quota_label)
    VALUES (?, ?, ?, ?, 1024, ?, ?, ?) RETURNING id`, [family, platform, modelId, modelId, priority, enabled, quota]));
}

describe('GET /api/embeddings/usage', () => {
  let app: Express;

  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
    (await getDb().run('DELETE FROM embedding_models'));
    app = createApp();
    dashToken = await mintDashboardToken();
  });

  it('keeps the original per-family fields', async () => {
    await seedFamily('bge-m3', 'cloudflare', '@cf/baai/bge-m3', 1, '10K neurons/day (shared)');

    const { status, body } = await get(app, '/api/embeddings/usage');
    expect(status).toBe(200);
    expect(body.families[0]).toMatchObject({
      family: 'bge-m3',
      requestsToday: 0,
      tokensMonth: 0,
    });
  });

  it('reports the highest-priority enabled provider for the legend', async () => {
    // Priority 2 is seeded first on purpose: order must come from priority.
    await seedFamily('bge-m3', 'huggingface', 'BAAI/bge-m3', 2, '$0.10/mo credits');
    await seedFamily('bge-m3', 'cloudflare', '@cf/baai/bge-m3', 1, '10K neurons/day (shared)');

    const { body } = await get(app, '/api/embeddings/usage');
    const f = body.families.find((x: any) => x.family === 'bge-m3');
    expect(f.platform).toBe('cloudflare');
    expect(f.quotaLabel).toBe('10K neurons/day (shared)');
  });

  it('sums tokens this month and totals across families', async () => {
    await seedFamily('bge-m3', 'cloudflare', '@cf/baai/bge-m3', 1, '10K neurons/day (shared)');
    await seedFamily('embed-v4.0', 'cohere', 'embed-v4.0', 1, '1K calls/mo');
    (await getDb().run(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, created_at, request_type)
      VALUES ('cloudflare', '@cf/baai/bge-m3', 'success', 120, 0, 10, to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS'), 'embedding'),
             ('cloudflare', '@cf/baai/bge-m3', 'success', 80, 0, 10, to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS'), 'embedding'),
             ('cohere', 'embed-v4.0', 'success', 50, 0, 10, to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS'), 'embedding') RETURNING id`));

    const { body } = await get(app, '/api/embeddings/usage');
    expect(body.totalTokensMonth).toBe(250);
    expect(body.totalRequestsToday).toBe(3);
    expect(body.totalTokensMonth).toBe(
      body.families.reduce((s: number, f: any) => s + f.tokensMonth, 0),
    );
  });

  it('ignores chat traffic on the same platform and model id', async () => {
    await seedFamily('bge-m3', 'cloudflare', '@cf/baai/bge-m3', 1, '10K neurons/day (shared)');
    (await getDb().run(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, created_at, request_type)
      VALUES ('cloudflare', '@cf/baai/bge-m3', 'success', 999, 0, 10, to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS'), 'chat') RETURNING id`));

    const { body } = await get(app, '/api/embeddings/usage');
    expect(body.totalTokensMonth).toBe(0);
  });

  it('exposes no budget field — quota labels are not token budgets', async () => {
    await seedFamily('bge-m3', 'cloudflare', '@cf/baai/bge-m3', 1, '10K neurons/day (shared)');

    const { body } = await get(app, '/api/embeddings/usage');
    expect(body).not.toHaveProperty('totalBudget');
    for (const f of body.families) expect(f).not.toHaveProperty('budget');
  });
});
