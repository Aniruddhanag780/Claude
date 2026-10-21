import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, setSetting } from '../../db/index.js';
import { initTestDb } from '../helpers/test-db.js';
import {
  getEndpointTimeBudgetMs,
  getEndpointTtfbStats,
  invalidateTtfbBudgetCache,
} from '../../lib/ttfb-budget.js';

const NOW = Date.parse('2026-09-19T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

async function addRequest(ttfbMs: number | string | null, opts: {
  platform?: string; modelId?: string; keyId?: number; status?: string; at?: number | string;
} = {}): void {
  const at = opts.at ?? NOW;
  (await getDb().run(`
    INSERT INTO requests (platform, model_id, key_id, status, ttfb_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id`, [opts.platform ?? 'google', opts.modelId ?? 'model', opts.keyId ?? null, opts.status ?? 'success', ttfbMs, typeof at === 'string' ? at : new Date(at).toISOString()]));
}

async function addCustomKey(baseUrl: string): number {
  return Number((await getDb().run(`
    INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, base_url)
    VALUES ('custom', 'enc', 'iv', 'tag', ?) RETURNING id`, [baseUrl])).lastInsertRowid);
}

describe('endpoint TTFB budgets (#1262)', () => {
  beforeEach(async () => {
    vi.stubEnv('DEV_MODE', 'true');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('TTFB_BUDGET_DISABLED', '');
    vi.stubEnv('TTFB_BUDGET_MIN_SAMPLES', '1');
    vi.stubEnv('SLOW_ENDPOINT_BUFFER_MS', '');
    vi.stubEnv('TTFB_BUDGET_WINDOW_MS', '');
    vi.stubEnv('TTFB_BUDGET_HALF_LIFE_MS', '');
    await initTestDb();
    invalidateTtfbBudgetCache();
  });

  afterEach(() => {
    getDb().close?.();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    invalidateTtfbBudgetCache();
  });

  it('retains the configured base for a cold or fast endpoint, and raises it for a slow one', async () => {
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(45_000);
    await addRequest(1_000);
    await addRequest(55_000, { platform: 'groq' });
    invalidateTtfbBudgetCache();
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(45_000);
    expect(await getEndpointTimeBudgetMs(45_000, 'groq', '', NOW)).toBe(65_000);
  });

  it('calculates nearest-rank P50/P95 across models of an endpoint', async () => {
    for (let i = 1; i <= 20; i++) await addRequest(i * 1_000, { modelId: `model-${i}` });
    expect(await getEndpointTtfbStats('google', '', NOW)).toEqual({
      p50Ms: 10_000, p95Ms: 19_000, sampleCount: 20, weightedSamples: 20,
    });
  });

  it('needs five successes by default before one slow anecdote widens the budget', async () => {
    vi.stubEnv('TTFB_BUDGET_MIN_SAMPLES', '');
    for (let i = 0; i < 4; i++) await addRequest(60_000);
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(45_000);
    await addRequest(60_000);
    invalidateTtfbBudgetCache();
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(70_000);
    await setSetting('ttfb_budget_min_samples', '6');
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(45_000);
  });

  it('caps the learned allowance at three times the base so it cannot ratchet', async () => {
    await addRequest(500_000);
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(135_000);
    expect(await getEndpointTimeBudgetMs(6_000, 'google', '', NOW)).toBe(18_000);
  });

  it('keeps a small base budget for a fast endpoint despite the absolute buffer', async () => {
    await addRequest(200);
    await addRequest(5_000, { platform: 'groq' });
    expect(await getEndpointTimeBudgetMs(6_000, 'google', '', NOW)).toBe(6_000);
    expect(await getEndpointTimeBudgetMs(6_000, 'groq', '', NOW)).toBe(15_000);
  });

  it('does not widen the budget from a zero TTFB observation alone', async () => {
    await addRequest(0);
    await setSetting('slow_endpoint_buffer_ms', '120000');
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(45_000);
  });

  it('decays observations with a two-day half life so recent recovery wins', async () => {
    await addRequest(60_000, { at: NOW - 6 * DAY_MS });
    for (let i = 0; i < 3; i++) await addRequest(2_000);
    expect(await getEndpointTtfbStats('google', '', NOW)).toEqual({
      p50Ms: 2_000, p95Ms: 2_000, sampleCount: 4, weightedSamples: 3.125,
    });
  });

  it('isolates custom scopes, combines keys for the same relay and keeps orphan history unscoped', async () => {
    const a1 = await addCustomKey('https://a.example/v1/');
    const a2 = await addCustomKey('https://a.example/v1');
    const b = await addCustomKey('https://b.example/v1');
    await addRequest(60_000, { platform: 'custom', keyId: a1 });
    await addRequest(70_000, { platform: 'custom', keyId: a2 });
    await addRequest(2_000, { platform: 'custom', keyId: b });
    await addRequest(90_000, { platform: 'custom', keyId: 999_999 });
    expect(await getEndpointTimeBudgetMs(45_000, 'custom', ' https://a.example/v1/// ', NOW)).toBe(80_000);
    expect((await getEndpointTtfbStats('custom', 'https://a.example/v1', NOW))?.sampleCount).toBe(2);
    expect(await getEndpointTimeBudgetMs(45_000, 'custom', 'https://b.example/v1', NOW)).toBe(45_000);
    expect(await getEndpointTimeBudgetMs(45_000, 'custom', 'https://new.example/v1', NOW)).toBe(45_000);
    expect(await getEndpointTimeBudgetMs(45_000, 'custom', '', NOW)).toBe(100_000);
  });

  it('ignores failed, canceled, expired, future, invalid and missing observations', async () => {
    await addRequest(1_000);
    await addRequest(900_000, { status: 'error' });
    await addRequest(900_000, { status: 'canceled' });
    await addRequest(900_000, { at: NOW - 7 * DAY_MS - 1 });
    await addRequest(900_000, { at: NOW + 1 });
    await addRequest(900_000, { at: 'not-a-date' });
    await addRequest(-1);
    await addRequest(Infinity);
    await addRequest('invalid');
    await addRequest(null);
    expect(await getEndpointTtfbStats('google', '', NOW)).toEqual({
      p50Ms: 1_000, p95Ms: 1_000, sampleCount: 1, weightedSamples: 1,
    });
  });

  it('treats SQLite times as UTC and accepts ISO offsets at the exact window boundary', async () => {
    await addRequest(1_000, { at: '2026-09-19 12:00:00' });
    await addRequest(1_000, { at: '2026-09-19T08:00:00-04:00' });
    await addRequest(1_000, { at: '2026-09-12 12:00:00' });
    await addRequest(1_000, { at: '2026-09-12T00:00:00-12:00' });
    expect((await getEndpointTtfbStats('google', '', NOW))?.sampleCount).toBe(4);
  });

  it('settings override env immediately and zero is a valid safety buffer', async () => {
    await addRequest(60_000);
    vi.stubEnv('SLOW_ENDPOINT_BUFFER_MS', '20000');
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(80_000);
    await setSetting('slow_endpoint_buffer_ms', '5000');
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(65_000);
    await setSetting('slow_endpoint_buffer_ms', '0');
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(60_000);
    await setSetting('slow_endpoint_buffer_ms', 'NaN');
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(80_000);
    vi.stubEnv('SLOW_ENDPOINT_BUFFER_MS', '-1');
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(70_000);
  });

  it('recomputes cached samples when the configured window or half life changes', async () => {
    await addRequest(60_000, { at: NOW - 6 * DAY_MS });
    for (let i = 0; i < 3; i++) await addRequest(2_000);
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(45_000);
    vi.stubEnv('TTFB_BUDGET_HALF_LIFE_MS', String(20 * DAY_MS));
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(70_000);
    await setSetting('ttfb_budget_window_ms', String(DAY_MS));
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(45_000);
    await setSetting('ttfb_budget_window_ms', '0');
    vi.stubEnv('TTFB_BUDGET_WINDOW_MS', 'Infinity');
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(70_000);
    await setSetting('ttfb_budget_half_life_ms', String(2 * DAY_MS));
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(45_000);
  });

  it('caches scans for a minute but discards cache when the database changes', async () => {
    await addRequest(1_000);
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(45_000);
    await addRequest(60_000);
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW + 59_999)).toBe(45_000);
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW + 60_000)).toBe(70_000);
    getDb().close?.();
    await initTestDb();
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW + 60_001)).toBe(45_000);
  });

  it('preserves an explicitly disabled budget and supports the emergency env switch', async () => {
    await addRequest(60_000);
    expect(await getEndpointTimeBudgetMs(0, 'google', '', NOW)).toBe(0);
    vi.stubEnv('TTFB_BUDGET_DISABLED', '1');
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(45_000);
    vi.stubEnv('TTFB_BUDGET_DISABLED', '0');
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(70_000);
  });

  it('falls back safely on DB errors and nonfinite derived budgets', async () => {
    await addRequest(Number.MAX_VALUE);
    await setSetting('slow_endpoint_buffer_ms', String(Number.MAX_VALUE));
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(45_000);
    vi.spyOn(getDb(), 'prepare').mockImplementation(() => { throw new Error('busy'); });
    expect(await getEndpointTimeBudgetMs(45_000, 'google', '', NOW)).toBe(45_000);
    expect(await getEndpointTtfbStats('google', '', NOW)).toBeNull();
  });
});
