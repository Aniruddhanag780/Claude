import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../db/index.js';
import { getQuotaForecast } from '../../services/quota-forecast.js';
import { initTestDb } from '../helpers/test-db.js';

async function insertState(row: {
  platform: string;
  keyId: number;
  pool: string;
  metric: string;
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
}) {
  (await getDb().run(`
    INSERT INTO provider_quota_state
      (platform, key_id, quota_pool_key, metric, limit_value, remaining_value, reset_at, observed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS'), to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS'))
  `, [row.platform, row.keyId, row.pool, row.metric, row.limit, row.remaining, row.resetAt]));
}

async function insertRequest(platform: string, isoCreatedAt: string, keyId = 1, modelId = 'groq/llama-3.3') {
  (await getDb().run(`INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type, created_at)
     VALUES (?, ?, ?, 'success', 10, 5, 100, NULL, 'chat', ?) RETURNING id`, [platform, modelId, keyId, isoCreatedAt.slice(0, 19).replace('T', ' ')]));
}

function isoPlus(hours: number): string {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

const future = () => isoPlus(12); // 12h ahead → within today

describe('quota-forecast: daily balance aggregation (#1104)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  beforeEach(async () => {
    (await getDb().run('DELETE FROM provider_quota_state'));
    (await getDb().run('DELETE FROM requests'));
  });

  it('reports used/remaining/pct/reset for a request pool with a known limit', async () => {
    await insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 60, resetAt: future() });

    const forecast = await getQuotaForecast();
    expect(forecast).toHaveLength(1);
    const e = forecast[0];
    expect(e.platform).toBe('groq');
    expect(e.pool).toBe('groq::account');
    expect(e.used).toBe(40);
    expect(e.remaining).toBe(60);
    expect(e.limit).toBe(100);
    expect(e.remaining_pct).toBe(60);
    expect(e.low_balance).toBe(false);
    expect(e.seconds_until_reset).toBeGreaterThan(0);
  });

  it('flags low_balance below the 10% threshold', async () => {
    await insertState({ platform: 'openai', keyId: 1, pool: 'openai::account', metric: 'requests', limit: 100, remaining: 8, resetAt: future() });

    const e = await await (await getQuotaForecast())[0];
    expect(e.remaining_pct).toBe(8);
    expect(e.low_balance).toBe(true);
  });

  it('flags low_balance on the absolute floor even when pct looks fine', async () => {
    await insertState({ platform: 'openrouter', keyId: 1, pool: 'openrouter::free', metric: 'requests', limit: 10000, remaining: 15, resetAt: future() });

    const e = await await (await getQuotaForecast())[0];
    expect(e.remaining_pct).toBe(0); // 15/10000 rounds to 0
    expect(e.low_balance).toBe(true);
  });

  it('dedupes multi-key shared pools to the tightest remaining', async () => {
    await insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 90, resetAt: future() });
    await insertState({ platform: 'groq', keyId: 2, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 20, resetAt: future() });

    const forecast = await getQuotaForecast();
    expect(forecast).toHaveLength(1);
    expect(forecast[0].remaining).toBe(20); // tightest wins
    // 20 of 100 is a fifth of the window, and 100 is below the absolute
    // floor's minimum, so nothing here is low.
    expect(forecast[0].low_balance).toBe(false);
  });

  it('does not apply the absolute floor to a small window', async () => {
    // A 30/day tier with 25 left has five sixths of its window: the absolute
    // floor of 20 would call that low, which is the bug this guards.
    await insertState({ platform: 'cerebras', keyId: 1, pool: 'cerebras::account', metric: 'requests', limit: 30, remaining: 25, resetAt: future() });

    const e = await await (await getQuotaForecast())[0];
    expect(e.remaining_pct).toBe(83);
    expect(e.low_balance).toBe(false);
  });

  it('still warns on a small window once the percentage rule bites', async () => {
    await insertState({ platform: 'cerebras', keyId: 1, pool: 'cerebras::account', metric: 'requests', limit: 30, remaining: 2, resetAt: future() });

    expect(await await (await getQuotaForecast())[0].low_balance).toBe(true);
  });

  it('leaves used null when the provider reported no remaining', async () => {
    await insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 100, remaining: null, resetAt: future() });

    const e = await await (await getQuotaForecast())[0];
    expect(e.used).toBeNull();
    expect(e.remaining).toBeNull();
    expect(e.remaining_pct).toBeNull();
    expect(e.low_balance).toBe(false);
  });

  it('keys the dedupe on the pool alone, which already names its platform', async () => {
    await insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 1000, remaining: 900, resetAt: future() });
    await insertState({ platform: 'groq', keyId: 2, pool: 'groq::batch', metric: 'requests', limit: 1000, remaining: 800, resetAt: future() });

    const pools = (await getQuotaForecast()).map(e => e.pool);
    expect(pools).toContain('groq::account');
    expect(pools).toContain('groq::batch');
  });

  it('ignores non-request metrics and unknown limits', async () => {
    await insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'tokens', limit: 1000, remaining: 500, resetAt: future() });
    await insertState({ platform: 'ollama', keyId: 1, pool: 'ollama::account', metric: 'requests', limit: null, remaining: null, resetAt: null });

    const forecast = await getQuotaForecast();
    expect(forecast).toHaveLength(0);
  });

  // --- estimated-exhaustion fields (the #1104 extension) ---

  it('returns null rate_exhaustion when the observation window is empty', async () => {
    await insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 80, resetAt: future() });
    // No recent requests inserted — rate is too sparse to estimate.
    const e = await await (await getQuotaForecast())[0];
    expect(e.rate_per_min).toBeNull();
    expect(e.estimated_exhaustion_at).toBeNull();
  });

  it('estimates exhaustion time once enough recent requests exist', async () => {
    await insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 30, resetAt: future() });
    // Insert 8 requests spread across the last 10-minute window — above the
    // 3-request minimum that marks a rate observable.
    const now = Date.now();
    for (let i = 1; i <= 8; i++) await insertRequest('groq', new Date(now - i * 60_000).toISOString());

    const e = await await (await getQuotaForecast())[0];
    expect(e.rate_per_min).toBeGreaterThan(0);
    expect(e.estimated_exhaustion_at).toBeTruthy();
    // The projection must land in the future (not past now).
    expect(new Date(e.estimated_exhaustion_at!).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns no exhaustion when the window resets before the quota runs out', async () => {
    await insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 10000, remaining: 9000, resetAt: isoPlus(1) });
    for (let i = 1; i <= 30; i++) await insertRequest('groq', new Date(Date.now() - i * 1000).toISOString());
    const e = await await (await getQuotaForecast())[0];
    expect(e.rate_per_min).toBe(3);
    expect(e.estimated_exhaustion_at).toBeNull();
  });

  it('counts only recent traffic from keys observed in the pool', async () => {
    await insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 30, resetAt: future() });
    for (let i = 0; i < 8; i++) {
      await insertRequest('groq', new Date(Date.now() - 60_000).toISOString(), 1);
      await insertRequest('groq', new Date(Date.now() - 60_000).toISOString(), 2);
      await insertRequest('groq', new Date(Date.now() - 20 * 60_000).toISOString(), 1);
      await insertRequest('groq', new Date(Date.now() + 60_000).toISOString(), 1);
    }
    expect(await await (await getQuotaForecast())[0].rate_per_min).toBe(0.8);
    await insertState({ platform: 'groq', keyId: 2, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 30, resetAt: future() });
    expect(await await (await getQuotaForecast())[0].rate_per_min).toBe(1.6);
  });

  it('keeps free and paid model traffic in their own OpenRouter pools', async () => {
    for (const pool of ['openrouter::free', 'openrouter::account']) {
      await insertState({ platform: 'openrouter', keyId: 1, pool, metric: 'requests', limit: 100, remaining: 30, resetAt: future() });
    }
    for (let i = 0; i < 5; i++) await insertRequest('openrouter', new Date(Date.now() - 60_000).toISOString(), 1, 'model:free');
    for (let i = 0; i < 9; i++) await insertRequest('openrouter', new Date(Date.now() - 60_000).toISOString(), 1, 'model-paid');
    const forecast = await getQuotaForecast();
    expect(forecast.find(e => e.pool === 'openrouter::free')?.rate_per_min).toBe(0.5);
    expect(forecast.find(e => e.pool === 'openrouter::account')?.rate_per_min).toBe(0.9);
  });

  it('ignores an invalid reset timestamp without throwing', async () => {
    await insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 30, resetAt: 'invalid' });
    for (let i = 0; i < 5; i++) await insertRequest('groq', new Date(Date.now() - 60_000).toISOString());
    expect(await await (await getQuotaForecast())[0].estimated_exhaustion_at).toBeNull();
  });

  it('leaves rate null when remaining is unknown', async () => {
    await insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 100, remaining: null, resetAt: future() });
    // The gate here is `remaining !== null`, not request volume.
    const e = await await (await getQuotaForecast())[0];
    expect(e.rate_per_min).toBeNull();
    expect(e.estimated_exhaustion_at).toBeNull();
  });

  it('excludes exhausted pools from estimation', async () => {
    await insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 0, resetAt: future() });
    // Even with many requests, remaining=0 → no projection.
    const now = Date.now();
    for (let i = 1; i <= 30; i++) await insertRequest('groq', new Date(now - i * 1000).toISOString());
    const e = await await (await getQuotaForecast())[0];
    expect(e.remaining).toBe(0);
    expect(e.estimated_exhaustion_at).toBeNull();
  });
});
