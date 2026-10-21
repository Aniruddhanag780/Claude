import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb } from '../../db/index.js';
import { initTestDb } from '../helpers/test-db.js';
import {
  canMakeRequest,
  canUseTokens,
  canUseProvider,
  canUseProviderMinute,
  acquireLease,
  releaseLease,
  resetLeases,
  recordRequest,
} from '../../services/ratelimit.js';

/**
 * The check-then-act race: routeRequest is synchronous, but usage is only written
 * after the awaited provider call. Without provisional accounting, N concurrent
 * requests all read the same pre-check, all pass, and collectively overshoot the
 * limit — which is exactly how a free tier gets 429ed by its own client.
 */
describe('in-flight leases count against the quota gates', () => {
  let keyId: number;

  beforeEach(async () => {
    await initTestDb();
    resetLeases();
    keyId = Math.floor(Math.random() * 1_000_000);
  });

  afterEach(() => {
    resetLeases();
    delete process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA;
  });

  const limits = (rpm: number | null) => ({ rpm, rpd: null, tpm: null, tpd: null });

  it('a single in-flight request consumes an rpm of 1', async () => {
    expect(await canMakeRequest('groq', 'm1', keyId, limits(1))).toBe(true);

    // Selection happened; nothing recorded yet because the call is still in flight.
    acquireLease('groq', 'm1', keyId, 100);

    // Before this change the second caller saw an unspent budget and dispatched.
    expect(await canMakeRequest('groq', 'm1', keyId, limits(1))).toBe(false);
  });

  it('frees the budget again once the lease is released', async () => {
    const id = acquireLease('groq', 'm1', keyId, 100);
    expect(await canMakeRequest('groq', 'm1', keyId, limits(1))).toBe(false);
    releaseLease(id);
    expect(await canMakeRequest('groq', 'm1', keyId, limits(1))).toBe(true);
  });

  it('stacks provisional on top of recorded usage', async () => {
    await recordRequest('groq', 'm1', keyId);          // 1 recorded
    acquireLease('groq', 'm1', keyId, 100);      // 1 in flight
    expect(await canMakeRequest('groq', 'm1', keyId, limits(3))).toBe(true);  // 2 of 3
    acquireLease('groq', 'm1', keyId, 100);      // 2 in flight → 3 of 3
    expect(await canMakeRequest('groq', 'm1', keyId, limits(3))).toBe(false);
  });

  it('scopes provisional requests to the same model and key', async () => {
    acquireLease('groq', 'other-model', keyId, 100);
    acquireLease('groq', 'm1', keyId + 1, 100);
    // Neither lease belongs to (m1, keyId), so its own budget is untouched.
    expect(await canMakeRequest('groq', 'm1', keyId, limits(1))).toBe(true);
  });

  it('counts promised tokens against tpm', async () => {
    const tokenLimits = { tpm: 1000, tpd: null };
    expect(await canUseTokens('groq', 'm1', keyId, 600, tokenLimits)).toBe(true);

    acquireLease('groq', 'm1', keyId, 600);   // 600 already promised
    // 600 in flight + 600 requested exceeds 1000.
    expect(await canUseTokens('groq', 'm1', keyId, 600, tokenLimits)).toBe(false);
    // A smaller request still fits.
    expect(await canUseTokens('groq', 'm1', keyId, 300, tokenLimits)).toBe(true);
  });

  it('counts in-flight requests against the provider-wide minute cap', async () => {
    process.env.PROVIDER_MINUTE_REQUEST_CAP_NVIDIA = '2';
    // Different models, one shared account budget — the whole point of that gate.
    acquireLease('nvidia', 'glm-4.7', keyId, 100);
    acquireLease('nvidia', 'minimax-m3', keyId, 100);
    expect(await canUseProviderMinute('nvidia', keyId)).toBe(false);
  });

  it('counts in-flight requests against the provider-wide daily cap', async () => {
    const now = Date.now();
    // OpenRouter ships a 1000/day default; sit one short of it.
    for (let i = 0; i < 999; i++) (await getDb().run(`
      INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
      VALUES ('openrouter', 'm1', ?, 'request', 0, ?) RETURNING id`, [keyId, now - 1000]));

    expect(await canUseProvider('openrouter', keyId, now)).toBe(true);
    acquireLease('openrouter', 'm1', keyId, 100, now);
    expect(await canUseProvider('openrouter', keyId, now)).toBe(false);
  });

  it('ignores an aged-out lease so a leak cannot block the gate forever', async () => {
    const now = Date.now();
    // Older than LEASE_MAX_AGE_MS (2 min).
    acquireLease('groq', 'm1', keyId, 100, now - 5 * 60 * 1000);
    expect(await canMakeRequest('groq', 'm1', keyId, limits(1))).toBe(true);
  });
});
