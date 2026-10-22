import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb } from '../../db/index.js';
import {
  canMakeRequest,
  canUseTokens,
  recordRequest,
  recordTokens,
  setCooldown,
  getRateLimitStatus,
  getNextCooldownDuration,
  getCooldownDurationForLimit,
  recentHitCount,
  canUseProvider,
  canUseProviderTokens,
  providerDailyRequestCount,
  getProviderDailyRequestCap,
  providerDailyTokenCount,
  getProviderDailyTokenCap,
} from '../../services/ratelimit.js';
import { parseRetryAfterMs } from '../../providers/base.js';
import { initTestDb } from '../helpers/test-db.js';

describe('Rate Limiter', () => {
  // Use unique identifiers per test to avoid cross-contamination
  let testId: number;

  beforeEach(() => {
    testId = Math.floor(Math.random() * 1_000_000);
  });

  describe('canMakeRequest', () => {
    it('should allow request when under RPM limit', async () => {
      expect(await canMakeRequest('groq', 'llama-70b', testId, {
        rpm: 30, rpd: null, tpm: null, tpd: null,
      })).toBe(true);
    });

    it('should deny request when RPM limit reached', async () => {
      const limits = { rpm: 2, rpd: null, tpm: null, tpd: null };
      await recordRequest('groq', 'llama-70b', testId);
      await recordRequest('groq', 'llama-70b', testId);
      expect(await canMakeRequest('groq', 'llama-70b', testId, limits)).toBe(false);
    });

    it('should deny request when RPD limit reached', async () => {
      const limits = { rpm: null, rpd: 1, tpm: null, tpd: null };
      await recordRequest('google', 'gemini', testId);
      expect(await canMakeRequest('google', 'gemini', testId, limits)).toBe(false);
    });

    it('should allow request when limits are null (unlimited)', async () => {
      expect(await canMakeRequest('nvidia', 'nemotron', testId, {
        rpm: null, rpd: null, tpm: null, tpd: null,
      })).toBe(true);
    });
  });

  describe('canUseTokens', () => {
    it('should allow tokens when under TPM limit', async () => {
      expect(await canUseTokens('groq', 'llama-70b', testId, 500, {
        tpm: 6000, tpd: null,
      })).toBe(true);
    });

    it('should deny tokens when TPM limit would be exceeded', async () => {
      await recordTokens('cerebras', 'qwen3', testId, 50000);
      expect(await canUseTokens('cerebras', 'qwen3', testId, 20000, {
        tpm: 60000, tpd: null,
      })).toBe(false);
    });

    it('should allow when limit is null', async () => {
      expect(await canUseTokens('nvidia', 'nemotron', testId, 100000, {
        tpm: null, tpd: null,
      })).toBe(true);
    });
  });

  describe('getRateLimitStatus', () => {
    it('should return current usage counts', async () => {
      const limits = { rpm: 30, rpd: 1000, tpm: 6000, tpd: null };
      await recordRequest('groq', 'test-model', testId);
      await recordRequest('groq', 'test-model', testId);
      await recordTokens('groq', 'test-model', testId, 500);

      const status = await getRateLimitStatus('groq', 'test-model', testId, limits);
      expect(status.rpm.used).toBe(2);
      expect(status.rpm.limit).toBe(30);
      expect(status.rpd.used).toBe(2);
      expect(status.tpm.used).toBe(500);
    });
  });

  describe('escalating cooldown', () => {
    it('escalates the 2nd/3rd/4th hit within 24h to 10m / 1h / 24h', async () => {
      const id = Math.floor(Math.random() * 1_000_000);
      const args = ['cerebras', `escalating-model-${id}`, id] as const;
      // 1st: 2 minutes
      expect(await getNextCooldownDuration(...args)).toBe(2 * 60 * 1000);
      // 2nd: 10 minutes
      expect(await getNextCooldownDuration(...args)).toBe(10 * 60 * 1000);
      // 3rd: 1 hour
      expect(await getNextCooldownDuration(...args)).toBe(60 * 60 * 1000);
      // 4th: 24 hours
      expect(await getNextCooldownDuration(...args)).toBe(24 * 60 * 60 * 1000);
      // 5th+ stays at 24h (quarantined until next quota window)
      expect(await getNextCooldownDuration(...args)).toBe(24 * 60 * 60 * 1000);
    });

    it('counts independently per (platform, model, key)', async () => {
      const id = Math.floor(Math.random() * 1_000_000);
      // Different keys for the same model should each start at 2m, not share state.
      expect(await getNextCooldownDuration('groq', `m-${id}`, id)).toBe(2 * 60 * 1000);
      expect(await getNextCooldownDuration('groq', `m-${id}`, id + 1)).toBe(2 * 60 * 1000);
      expect(await getNextCooldownDuration('groq', `m-${id}-other`, id)).toBe(2 * 60 * 1000);
    });
  });

  describe('getCooldownDurationForLimit (daily vs transient 429)', () => {
    it('uses a short, non-escalating cooldown when the daily quota is NOT exhausted', async () => {
      const id = Math.floor(Math.random() * 1_000_000);
      const args = ['groq', `transient-${id}`, id] as const;
      // groq-like: large daily quota, no requests recorded yet → transient (TPM/RPM)
      // 429s must stay at the short fixed cooldown and never escalate.
      expect(await getCooldownDurationForLimit(...args, { rpd: 1000, tpd: null })).toBe(90 * 1000);
      expect(await getCooldownDurationForLimit(...args, { rpd: 1000, tpd: null })).toBe(90 * 1000);
      expect(await getCooldownDurationForLimit(...args, { rpd: 1000, tpd: null })).toBe(90 * 1000);
    });

    it('stays transient for the first 429 with null daily limits (heuristic threshold)', async () => {
      const id = Math.floor(Math.random() * 1_000_000);
      // 1st 429 → transient (no signal yet). Subsequent 429s stay transient
      // until the threshold is crossed.
      expect(
        await getCooldownDurationForLimit('mistral', `nolimit-${id}`, id, { rpd: null, tpd: null }),
      ).toBe(90 * 1000);
    });

    it('escalates null-limit 429s only as far as the unknown-limit 10m cap', async () => {
      // Documented RPD path (see "escalates only once the daily request limit
      // is actually reached"): 1st call after counter ≥ limit → 2min (idx=0),
      // 2nd → 10min (idx=1), 3rd → HOUR (idx=2), 4th+ → DAY (idx=3).
      //
      // Null-limit path enters that ladder at the 2nd 429 (1st is transient —
      // no signal yet) but is capped at 10min: with no published RPD/TPD the
      // "exhausted" verdict is inferred from repeated 429s alone, and RPM
      // jitter is indistinguishable from a spent daily quota, so the guess is
      // never allowed to reach the 1h/24h quarantine steps.
      const id = Math.floor(Math.random() * 1_000_000);
      const platform = 'ollama';
      const model = `nolimit-esc-${id}`;
      // 1st 429 — no history → transient
      expect(await getCooldownDurationForLimit(platform, model, id, { rpd: null, tpd: null })).toBe(90 * 1000);
      // 2nd 429 — heuristic threshold (2) crossed → 2min (ladder idx=0)
      expect(await getCooldownDurationForLimit(platform, model, id, { rpd: null, tpd: null })).toBe(2 * 60 * 1000);
      // 3rd 429 → 10min (idx=1)
      expect(await getCooldownDurationForLimit(platform, model, id, { rpd: null, tpd: null })).toBe(10 * 60 * 1000);
      // 4th 429 — ladder says HOUR, cap holds it at 10min
      expect(await getCooldownDurationForLimit(platform, model, id, { rpd: null, tpd: null })).toBe(10 * 60 * 1000);
      // 5th 429 — ladder says DAY, cap holds it at 10min
      expect(await getCooldownDurationForLimit(platform, model, id, { rpd: null, tpd: null })).toBe(10 * 60 * 1000);
      // 6th+ stays at the cap, never the 24h quarantine
      expect(await getCooldownDurationForLimit(platform, model, id, { rpd: null, tpd: null })).toBe(10 * 60 * 1000);
    });

    it('keeps the full 24h ladder for a model with a real, exhausted RPD', async () => {
      // The cap is for GUESSED exhaustion only. A published rpd whose counter
      // is spent is measured evidence, so the quarantine steps stay reachable.
      const id = Math.floor(Math.random() * 1_000_000);
      const platform = 'openrouter';
      const model = `daily-esc-${id}`;
      for (let i = 0; i < 3; i++) await recordRequest(platform, model, id);
      const limits = { rpd: 3, tpd: null };
      expect(await getCooldownDurationForLimit(platform, model, id, limits)).toBe(2 * 60 * 1000);
      expect(await getCooldownDurationForLimit(platform, model, id, limits)).toBe(10 * 60 * 1000);
      expect(await getCooldownDurationForLimit(platform, model, id, limits)).toBe(60 * 60 * 1000);
      expect(await getCooldownDurationForLimit(platform, model, id, limits)).toBe(24 * 60 * 60 * 1000);
    });

    it('does NOT trigger the heuristic when limits are known (even after 5+ hits)', async () => {
      // rpd=1000 known: counters track it, daily-exhausted check uses the
      // counter, not the hit count. The null-limits heuristic only fires
      // when BOTH rpd AND tpd are null. With a known cap, repeated 429s
      // stay transient (the counter-based path takes over instead).
      const id = Math.floor(Math.random() * 1_000_000);
      const platform = 'openrouter';
      const model = `known-${id}`;
      for (let i = 0; i < 5; i++) {
        expect(await getCooldownDurationForLimit(platform, model, id, { rpd: 1000, tpd: null })).toBe(90 * 1000);
      }
      expect(recentHitCount(platform, model, id, Date.now())).toBe(0);
    });

    it('clears null-limit hit history after a successful request', async () => {
      const id = Math.floor(Math.random() * 1_000_000);
      const platform = 'ollama';
      const model = `nolimit-success-${id}`;

      expect(await getCooldownDurationForLimit(platform, model, id, { rpd: null, tpd: null })).toBe(90 * 1000);
      expect(await getCooldownDurationForLimit(platform, model, id, { rpd: null, tpd: null })).toBe(2 * 60 * 1000);
      expect(recentHitCount(platform, model, id, Date.now())).toBe(2);

      await recordRequest(platform, model, id);

      expect(recentHitCount(platform, model, id, Date.now())).toBe(0);
      expect(await getCooldownDurationForLimit(platform, model, id, { rpd: null, tpd: null })).toBe(90 * 1000);
    });

    it('escalates only once the daily request limit is actually reached', async () => {
      const id = Math.floor(Math.random() * 1_000_000);
      const platform = 'openrouter';
      const model = `daily-${id}`;
      // Below the daily limit → still transient.
      await recordRequest(platform, model, id);
      expect(await getCooldownDurationForLimit(platform, model, id, { rpd: 5, tpd: null })).toBe(90 * 1000);
      // Reach the daily limit → now it escalates (2m, then 10m, ...).
      for (let i = 0; i < 5; i++) await recordRequest(platform, model, id);
      expect(await getCooldownDurationForLimit(platform, model, id, { rpd: 5, tpd: null })).toBe(2 * 60 * 1000);
      expect(await getCooldownDurationForLimit(platform, model, id, { rpd: 5, tpd: null })).toBe(10 * 60 * 1000);
    });
  });

  describe('persistent state', () => {
    it('preserves per-key usage and cooldowns after the limiter module reloads', async () => {
      process.env.ENCRYPTION_KEY = '0'.repeat(64);
      const keyId = 4242;

      await initTestDb();

      await recordRequest('groq', 'persistent-model', keyId);
      await recordTokens('groq', 'persistent-model', keyId, 950);
      setCooldown('groq', 'persistent-model', keyId, 60_000);

      // Reload the limiter module. A fresh module holds no in-memory state, so
      // anything it can still see came back out of the database. On PG there
      // is no database FILE to reopen — the persistence IS the database.
      vi.resetModules();
      const dbModule = await import('../../db/index.js');
      await dbModule.connectDb();
      const limiterAfterReload = await import('../../services/ratelimit.js');
      try {
        expect(await limiterAfterReload.canMakeRequest('groq', 'persistent-model', keyId, {
          rpm: null, rpd: 1, tpm: null, tpd: null,
        })).toBe(false);
        expect(await limiterAfterReload.canUseTokens('groq', 'persistent-model', keyId, 100, {
          tpm: null, tpd: 1000,
        })).toBe(false);
        expect(await limiterAfterReload.isOnCooldown('groq', 'persistent-model', keyId)).toBe(true);
      } finally {
        await dbModule.closeDb().catch(() => { /* already closed */ });
      }
    });
  });

  describe('provider-wide daily request cap (#162)', () => {
    const ENV = 'PROVIDER_DAILY_REQUEST_CAP_OPENROUTER';
    let original: string | undefined;

    beforeEach(() => { original = process.env[ENV]; });
    afterEach(() => {
      if (original === undefined) delete process.env[ENV];
      else process.env[ENV] = original;
    });

    it('defaults to OpenRouter ~1000/day and allows env override / disable', () => {
      delete process.env[ENV];
      expect(getProviderDailyRequestCap('openrouter')).toBe(1000);
      // ModelScope: 2000/day account-wide upstream, shipped as 1800 for margin (#581).
      expect(getProviderDailyRequestCap('modelscope')).toBe(1800);
      // Requesty: 200/day across all free models, shipped as 180 for margin.
      expect(getProviderDailyRequestCap('requesty')).toBe(180);
      expect(getProviderDailyRequestCap('groq')).toBeNull(); // no shared cap
      process.env[ENV] = '50';
      expect(getProviderDailyRequestCap('openrouter')).toBe(50);
      process.env[ENV] = '0'; // 0 disables the cap
      expect(getProviderDailyRequestCap('openrouter')).toBeNull();
    });

    it('counts requests across ALL of a provider\'s models for one key', async () => {
      await recordRequest('openrouter', 'deepseek/deepseek-v3.1:free', testId);
      await recordRequest('openrouter', 'deepseek/deepseek-v3.1:free', testId);
      await recordRequest('openrouter', 'qwen/qwen3-coder:free', testId);
      // Same key on a different provider must not bleed into the count.
      await recordRequest('groq', 'llama-70b', testId);
      expect(await providerDailyRequestCount('openrouter', testId)).toBe(3);
    });

    it('blocks the whole provider once the shared daily cap is hit', async () => {
      process.env[ENV] = '3';
      await recordRequest('openrouter', 'model-a', testId);
      await recordRequest('openrouter', 'model-b', testId);
      expect(await canUseProvider('openrouter', testId)).toBe(true); // 2 < 3
      await recordRequest('openrouter', 'model-c', testId);
      expect(await canUseProvider('openrouter', testId)).toBe(false); // 3 >= 3
    });

    it('shares the Requesty daily cap across its free models by default', async () => {
      for (let i = 0; i < 179; i++) {
        await recordRequest('requesty', i % 2 ? 'google/gemma-4-31b-it' : 'nvidia/nemotron-3-super-120b-a12b', testId);
      }
      expect(await canUseProvider('requesty', testId)).toBe(true); // 179 < 180
      await recordRequest('requesty', 'mistral/leanstral-1-5', testId);
      expect(await canUseProvider('requesty', testId)).toBe(false); // 180 >= 180
    });
  });

  describe('provider-wide daily token cap (NavyAI)', () => {
    const ENV = 'PROVIDER_DAILY_TOKEN_CAP_NAVY';
    let original: string | undefined;
    let dbReady = false;

    async function ensureDb() {
      if (dbReady) return;
      process.env.ENCRYPTION_KEY = '0'.repeat(64);
      await initTestDb();
      dbReady = true;
    }

    async function seedNavyModel(modelId: string, tpdLimit: number, monthlyTokenBudget: string) {
      (await getDb().run(`
        INSERT INTO models (
          platform, model_id, display_name, intelligence_rank, speed_rank,
          size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit,
          monthly_token_budget, context_window, enabled, supports_vision,
          supports_tools
        ) VALUES (
          'navy', ?, ?, 1, 1, 'Large', 20, NULL, NULL, ?,
          ?, NULL, 1, 0, 1
        )
        ON CONFLICT(platform, model_id, endpoint_scope) DO UPDATE SET
          tpd_limit = excluded.tpd_limit,
          monthly_token_budget = excluded.monthly_token_budget
      `, [modelId, `${modelId} (NavyAI)`, tpdLimit, monthlyTokenBudget]));
    }

    beforeEach(async () => {
      await ensureDb();
      original = process.env[ENV];
      (await getDb().run('DELETE FROM rate_limit_usage'));
      (await getDb().run("DELETE FROM models WHERE platform = 'navy'"));
      delete process.env[ENV];
    });

    afterEach(() => {
      if (original === undefined) delete process.env[ENV];
      else process.env[ENV] = original;
    });

    it('defaults to NavyAI 150K tokens/day and allows env override / disable', () => {
      expect(getProviderDailyTokenCap('navy')).toBe(150_000);
      expect(getProviderDailyTokenCap('groq')).toBeNull();
      process.env[ENV] = '5000';
      expect(getProviderDailyTokenCap('navy')).toBe(5000);
      process.env[ENV] = '0';
      expect(getProviderDailyTokenCap('navy')).toBeNull();
    });

    it('counts NavyAI tokens across all models using catalog multiplier hints', async () => {
      await seedNavyModel('gpt-5.4', 33_333, '150K/day shared \u00b7 4.5x');
      await seedNavyModel('llama-3.3-70b-instruct', 150_000, '150K/day shared \u00b7 1x');

      await recordTokens('navy', 'gpt-5.4', testId, 1000);
      await recordTokens('navy', 'llama-3.3-70b-instruct', testId, 1000);

      expect(await providerDailyTokenCount('navy', testId)).toBe(5500);
    });

    it('blocks the provider key when multiplier-adjusted tokens would exceed the shared cap', async () => {
      process.env[ENV] = '5000';
      await seedNavyModel('gemini-2.5-flash', 75_000, '150K/day shared \u00b7 2x');

      await recordTokens('navy', 'gemini-2.5-flash', testId, 2000);

      expect(await canUseProviderTokens('navy', testId, 'gemini-2.5-flash', 400)).toBe(true);
      expect(await canUseProviderTokens('navy', testId, 'gemini-2.5-flash', 600)).toBe(false);
    });
  });
});

describe('Cooldown duration with upstream Retry-After', () => {
  const noLimits = { rpd: null, tpd: null };
  let testId: number;
  beforeEach(() => { testId = Math.floor(Math.random() * 1_000_000); });

  it('uses the transient cooldown when no Retry-After is given', async () => {
    expect(await getCooldownDurationForLimit('groq', 'm', testId, noLimits)).toBe(90_000);
  });

  it('never benches shorter than the heuristic (ignores a shorter Retry-After)', async () => {
    expect(await getCooldownDurationForLimit('groq', 'm', testId, noLimits, 30_000)).toBe(90_000);
  });

  it('honors a Retry-After longer than the heuristic', async () => {
    expect(await getCooldownDurationForLimit('groq', 'm', testId, noLimits, 300_000)).toBe(300_000);
  });

  it('caps an absurd Retry-After at a day', async () => {
    expect(await getCooldownDurationForLimit('groq', 'm', testId, noLimits, 5 * 86_400_000)).toBe(86_400_000);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('parses an HTTP-date into a positive future delay', () => {
    const ms = parseRetryAfterMs(new Date(Date.now() + 60_000).toUTCString());
    expect(ms).toBeGreaterThan(50_000);
    expect(ms).toBeLessThanOrEqual(60_000);
  });

  it('returns undefined for absent or unparseable values', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
  });

  const DAY_MS = 24 * 60 * 60 * 1000;

  it('clamps an absurd delta-seconds value to 24h', () => {
    // Feeds the cooldown expiry directly, so an unclamped value benches the key
    // effectively forever.
    expect(parseRetryAfterMs('99999999999')).toBe(DAY_MS);
    expect(parseRetryAfterMs(String(DAY_MS / 1000 + 1))).toBe(DAY_MS);
  });

  it('clamps a far-future HTTP-date to 24h', () => {
    expect(parseRetryAfterMs(new Date(Date.now() + 30 * DAY_MS).toUTCString())).toBe(DAY_MS);
  });

  it('leaves values at or under 24h untouched', () => {
    expect(parseRetryAfterMs(String(DAY_MS / 1000))).toBe(DAY_MS);
    expect(parseRetryAfterMs('3600')).toBe(3_600_000);
  });
});
