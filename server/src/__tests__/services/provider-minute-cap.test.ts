import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb } from '../../db/index.js';
import { initTestDb } from '../helpers/test-db.js';
import {
  canUseProviderMinute,
  providerMinuteRequestCount,
  getProviderMinuteRequestCap,
} from '../../services/ratelimit.js';

/**
 * Account-wide per-minute caps. The per-model rpm_limit cannot express these:
 * NVIDIA NIM meters ~40 req/min across the whole account, so every model on it
 * draws from one bucket, and a model row with rpm_limit NULL isn't pre-throttled
 * at all. Without this gate the router keeps dispatching and eats real 429s.
 */
async function seedRequests(platform: string, modelId: string, keyId: number, count: number, atMs: number) {
  for (let i = 0; i < count; i++) (await getDb().run(`
    INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
    VALUES (?, ?, ?, 'request', 0, ?) RETURNING id`, [platform, modelId, keyId, atMs]));
}

describe('provider-wide per-minute request cap', () => {
  let keyId: number;

  beforeEach(async () => {
    await initTestDb();
    keyId = Math.floor(Math.random() * 1_000_000);
  });

  afterEach(() => {
    delete process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA;
    delete process.env.PROVIDER_MINUTE_REQUEST_CAP_GROQ;
    delete process.env.PROVIDER_MINUTE_REQUEST_CAP_APINEX;
  });

  it('ships a default cap for nvidia and none for a provider without one', () => {
    expect(getProviderMinuteRequestCap('nvidia')).toBe(40);
    expect(getProviderMinuteRequestCap('groq')).toBeNull();
  });

  it('applies the APINex 5 RPM cap across different free models, per key', async () => {
    const now = Date.now();
    expect(getProviderMinuteRequestCap('apinex')).toBe(5);
    seedRequests('apinex', 'free/deepseek-v4.1-flash', keyId, 3, now - 20_000);
    seedRequests('apinex', 'free/gpt-6-luna', keyId, 2, now - 10_000);
    expect(await providerMinuteRequestCount('apinex', keyId, now)).toBe(5);
    expect(await canUseProviderMinute('apinex', keyId, now)).toBe(false);
    expect(await canUseProviderMinute('apinex', keyId + 1, now)).toBe(true);
    expect(await canUseProviderMinute('apinex', keyId, now + 61_000)).toBe(true);
  });

  it('honours an env override and treats 0 as disabled', () => {
    process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA = '5';
    expect(getProviderMinuteRequestCap('nvidia')).toBe(5);
    process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA = '0';
    expect(getProviderMinuteRequestCap('nvidia')).toBeNull();
  });

  it('sums usage across every model on the same account+key', async () => {
    const now = Date.now();
    // The whole point: three different models, one shared budget.
    seedRequests('nvidia', 'glm-4.7', keyId, 10, now - 5_000);
    seedRequests('nvidia', 'minimax-m3', keyId, 10, now - 4_000);
    seedRequests('nvidia', 'deepseek-v4', keyId, 10, now - 3_000);

    expect(await providerMinuteRequestCount('nvidia', keyId, now)).toBe(30);
  });

  it('blocks once the shared budget is spent, even for an untouched model', async () => {
    process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA = '40';
    const now = Date.now();
    seedRequests('nvidia', 'glm-4.7', keyId, 40, now - 10_000);

    // deepseek-v4 has made zero requests of its own and may well have a NULL
    // rpm_limit, but the account budget is gone.
    expect(await canUseProviderMinute('nvidia', keyId, now)).toBe(false);
  });

  it('allows again once the minute window rolls past', async () => {
    process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA = '40';
    const now = Date.now();
    seedRequests('nvidia', 'glm-4.7', keyId, 40, now - 61_000);

    expect(await providerMinuteRequestCount('nvidia', keyId, now)).toBe(0);
    expect(await canUseProviderMinute('nvidia', keyId, now)).toBe(true);
  });

  it('does not gate a provider with no configured cap', async () => {
    const now = Date.now();
    seedRequests('groq', 'llama-3.3-70b', keyId, 500, now - 1_000);
    expect(await canUseProviderMinute('groq', keyId, now)).toBe(true);
  });

  it('keeps separate budgets per key on the same platform', async () => {
    process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA = '40';
    const now = Date.now();
    const other = keyId + 1;
    seedRequests('nvidia', 'glm-4.7', keyId, 40, now - 5_000);

    expect(await canUseProviderMinute('nvidia', keyId, now)).toBe(false);
    expect(await canUseProviderMinute('nvidia', other, now)).toBe(true);
  });
});
