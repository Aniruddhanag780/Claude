import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../../db/index.js';
import { initTestDb } from '../helpers/test-db.js';
import {
  providerDailyRequestCount,
  providerDailyTokenCount,
  canUseProvider,
  getActiveCooldownsForKeys,
  clearCooldownsForKey,
  setCooldown,
  isOnCooldown,
} from '../../services/ratelimit.js';

const HOUR = 60 * 60 * 1000;

function utcMidnight(now: number): number {
  return new Date(now).setUTCHours(0, 0, 0, 0);
}

/** Insert a usage row at an explicit timestamp, bypassing recordRequest so the
 *  test controls where the row sits relative to the UTC day boundary. */
async function seedUsage(
  platform: string,
  modelId: string,
  keyId: number,
  kind: 'request' | 'tokens',
  tokens: number,
  atMs: number,
) {
  (await getDb().run(`
    INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id`, [platform, modelId, keyId, kind, tokens, atMs]));
}

describe('provider daily caps use a midnight-UTC boundary', () => {
  let keyId: number;

  beforeEach(async () => {
    await initTestDb();
    keyId = Math.floor(Math.random() * 1_000_000);
  });

  it('excludes usage from before midnight UTC', async () => {
    // "Now" is fixed at 02:00 UTC so there is a real yesterday to test against.
    const now = utcMidnight(Date.now()) + 2 * HOUR;
    const beforeMidnight = utcMidnight(now) - HOUR;      // 23:00 yesterday
    const afterMidnight = utcMidnight(now) + 30 * 60_000; // 00:30 today

    await seedUsage('openrouter', 'm1', keyId, 'request', 0, beforeMidnight);
    await seedUsage('openrouter', 'm1', keyId, 'request', 0, beforeMidnight + 60_000);
    await seedUsage('openrouter', 'm1', keyId, 'request', 0, afterMidnight);

    // A sliding 24h window would count all three; only today's should count.
    expect(await providerDailyRequestCount('openrouter', keyId, now)).toBe(1);
  });

  it('counts every request made since midnight UTC', async () => {
    const now = utcMidnight(Date.now()) + 6 * HOUR;
    // Offset by 1ms: the usage window is half-open (created_at_ms > cutoff), so a
    // row stamped exactly at the boundary belongs to the day that just started.
    for (let i = 0; i < 4; i++) {
      await seedUsage('openrouter', `m${i}`, keyId, 'request', 0, utcMidnight(now) + 1 + i * HOUR);
    }
    expect(await providerDailyRequestCount('openrouter', keyId, now)).toBe(4);
  });

  it('releases a capped provider once the day boundary passes', async () => {
    process.env.PROVIDER_DAILY_REQUEST_CAP_OPENROUTER = '2';
    try {
      const yesterdayEvening = utcMidnight(Date.now()) - 2 * HOUR;
      await seedUsage('openrouter', 'm1', keyId, 'request', 0, yesterdayEvening);
      await seedUsage('openrouter', 'm1', keyId, 'request', 0, yesterdayEvening + 60_000);

      // Evaluated at 23:59 yesterday the cap is spent...
      expect(await canUseProvider('openrouter', keyId, yesterdayEvening + 2 * HOUR - 1)).toBe(false);
      // ...and immediately available again after the UTC reset, which a sliding
      // window would not do until a full 24h had elapsed.
      expect(await canUseProvider('openrouter', keyId, utcMidnight(Date.now()) + 60_000)).toBe(true);
    } finally {
      delete process.env.PROVIDER_DAILY_REQUEST_CAP_OPENROUTER;
    }
  });

  it('applies the same boundary to token accounting', async () => {
    const now = utcMidnight(Date.now()) + 3 * HOUR;
    await seedUsage('navy', 'm1', keyId, 'tokens', 5_000, utcMidnight(now) - HOUR);
    await seedUsage('navy', 'm1', keyId, 'tokens', 1_200, utcMidnight(now) + HOUR);

    expect(await providerDailyTokenCount('navy', keyId, now)).toBe(1_200);
  });

  it('counts nothing at exactly midnight UTC', async () => {
    const midnight = utcMidnight(Date.now());
    await seedUsage('openrouter', 'm1', keyId, 'request', 0, midnight - 60_000);
    expect(await providerDailyRequestCount('openrouter', keyId, midnight)).toBe(0);
  });
});

describe('cooldown visibility and manual clear', () => {
  beforeEach(async () => {
    await initTestDb();
  });

  it('reports active cooldowns grouped by key with remaining time', async () => {
    setCooldown('groq', 'llama-3.3-70b', 11, 60_000);
    setCooldown('groq', 'llama-3.1-8b', 11, 120_000);
    setCooldown('cerebras', 'qwen-3-coder', 12, 90_000);

    const grouped = await getActiveCooldownsForKeys([11, 12]);

    expect(grouped.get(11)).toHaveLength(2);
    expect(grouped.get(12)).toHaveLength(1);
    const first = grouped.get(11)!.map(c => c.modelId).sort();
    expect(first).toEqual(['llama-3.1-8b', 'llama-3.3-70b']);
    for (const cd of grouped.get(11)!) {
      expect(cd.remainingMs).toBeGreaterThan(0);
      expect(cd.expiresAtMs).toBeGreaterThan(Date.now());
    }
  });

  it('omits expired cooldowns and keys with none', async () => {
    setCooldown('groq', 'llama-3.3-70b', 21, -5_000); // already expired
    const grouped = await getActiveCooldownsForKeys([21, 22]);
    expect(grouped.get(21)).toBeUndefined();
    expect(grouped.get(22)).toBeUndefined();
  });

  it('returns an empty map for an empty or invalid key list', async () => {
    expect((await getActiveCooldownsForKeys([])).size).toBe(0);
    expect((await getActiveCooldownsForKeys([Number.NaN])).size).toBe(0);
  });

  it('clears every cooldown for one key and leaves other keys alone', async () => {
    setCooldown('groq', 'llama-3.3-70b', 31, 10 * 60_000);
    setCooldown('groq', 'llama-3.1-8b', 31, 10 * 60_000);
    setCooldown('groq', 'llama-3.3-70b', 32, 10 * 60_000);

    expect(await isOnCooldown('groq', 'llama-3.3-70b', 31)).toBe(true);

    const cleared = await clearCooldownsForKey(31);

    expect(cleared).toBe(2);
    // Both the persisted row and the in-memory entry must be gone, or the next
    // isOnCooldown would re-hydrate the cooldown from whichever survived.
    expect(await isOnCooldown('groq', 'llama-3.3-70b', 31)).toBe(false);
    expect(await isOnCooldown('groq', 'llama-3.1-8b', 31)).toBe(false);
    expect(await isOnCooldown('groq', 'llama-3.3-70b', 32)).toBe(true);
    expect((await getActiveCooldownsForKeys([31])).size).toBe(0);
  });

  it('reports zero when a key has nothing to clear', async () => {
    expect(await clearCooldownsForKey(999_001)).toBe(0);
    expect(await clearCooldownsForKey(Number.NaN)).toBe(0);
  });
});
