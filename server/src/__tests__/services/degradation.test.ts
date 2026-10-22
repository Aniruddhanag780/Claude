import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { initTestDb } from '../helpers/test-db.js';

const { getDb } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const {
  computeHealthSnapshot,
  updateDegradationState,
  getDegradationStatus,
  isDegraded,
  resetDegradationState,
} = await import('../../services/degradation.js');

// #904 degraded-mode state machine: when the healthy-provider ratio stays
// below the threshold for a sustained period, the gateway flips to degraded
// mode (router stops exploring, health endpoint reports the state); recovery
// needs the ratio back above threshold for a longer grace period.

let nextId = 40000;

async function seedKey(platform: string, opts: { status?: string; enabled?: number } = {}): number {
  const id = ++nextId;
  const enc = encrypt(`deg-${id}`);
  (await getDb().run(`
    INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, enabled, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, [id, platform, `deg-${id}`, enc.encrypted, enc.iv, enc.authTag, opts.enabled ?? 1, opts.status ?? 'healthy']));
  return id;
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  await initTestDb();
});

beforeEach(async () => {
  (await getDb().run('DELETE FROM api_keys'));
  resetDegradationState();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('degraded-mode state machine', () => {
  it('reports normal with all providers healthy', async () => {
    await seedKey('groq');
    await seedKey('cloudflare');
    await seedKey('mistral');
    const s = await updateDegradationState(0);
    expect(s.state).toBe('normal');
    expect(s.healthyProviders).toBe(3);
    expect(s.totalProviders).toBe(3);
    expect(s.ratio).toBe(1);
    expect(isDegraded()).toBe(false);
  });

  it('counts unknown-status keys as usable, error keys as not', async () => {
    await seedKey('groq', { status: 'unknown' });
    await seedKey('cloudflare', { status: 'healthy' });
    await seedKey('mistral', { status: 'error' });
    const snap = await computeHealthSnapshot();
    expect(snap.healthyProviders).toBe(2);
    expect(snap.totalProviders).toBe(3);
    expect(snap.ratio).toBeCloseTo(2 / 3);
  });

  it('ignores disabled keys', async () => {
    await seedKey('groq', { enabled: 0, status: 'healthy' });
    await seedKey('cloudflare', { enabled: 0, status: 'healthy' });
    await seedKey('mistral', { enabled: 0, status: 'healthy' });
    const snap = await computeHealthSnapshot();
    expect(snap.totalProviders).toBe(0);
    expect(snap.ratio).toBe(1); // no providers to judge → not degraded
  });

  it('enters degraded mode only after the ratio stays low for the grace period', async () => {
    await seedKey('groq', { status: 'healthy' });
    await seedKey('cloudflare', { status: 'error' });
    await seedKey('mistral', { status: 'error' });
    await seedKey('openai', { status: 'error' });

    // Below threshold (1/4 = 25% < 50%) but grace period not elapsed yet.
    const early = await updateDegradationState(0);
    expect(early.state).toBe('normal');
    expect(isDegraded()).toBe(false);

    // Within the entry grace (60s default) still normal.
    const within = await updateDegradationState(59_000);
    expect(within.state).toBe('normal');

    // Past the grace → degraded.
    const degraded = await updateDegradationState(60_000);
    expect(degraded.state).toBe('degraded');
    expect(degraded.degradedAt).not.toBeNull();
    expect(isDegraded()).toBe(true);
  });

  it('stays normal when the ratio is at or above the threshold', async () => {
    await seedKey('groq', { status: 'healthy' });
    await seedKey('cloudflare', { status: 'healthy' });
    await seedKey('mistral', { status: 'error' });
    await seedKey('openai', { status: 'error' });
    // 2/4 = 50% — exactly at the default threshold → not below.
    const s = await updateDegradationState(0);
    expect(s.state).toBe('normal');
  });

  it('exits degraded mode only after recovery grace elapses', async () => {
    await seedKey('groq', { status: 'healthy' });
    await seedKey('cloudflare', { status: 'error' });
    await seedKey('mistral', { status: 'error' });
    await seedKey('openai', { status: 'error' });
    await updateDegradationState(0);
    await updateDegradationState(60_000);
    expect(isDegraded()).toBe(true);

    // Providers recover, but the exit grace (120s default) hasn't elapsed.
    (await getDb().run("UPDATE api_keys SET status = 'healthy' WHERE platform IN ('cloudflare', 'mistral', 'openai')"));
    const recovering = await updateDegradationState(60_001);
    expect(recovering.state).toBe('degraded'); // still degraded
    expect(isDegraded()).toBe(true);

    // Past the exit grace → back to normal.
    const recovered = await updateDegradationState(60_001 + 120_000);
    expect(recovered.state).toBe('normal');
    expect(recovered.degradedAt).toBeNull();
    expect(isDegraded()).toBe(false);
  });

  it('does not flap: a transient single-pass recovery resets the recovery streak', async () => {
    await seedKey('groq', { status: 'healthy' });
    await seedKey('cloudflare', { status: 'error' });
    await seedKey('mistral', { status: 'error' });
    await seedKey('openai', { status: 'error' });
    await updateDegradationState(0);
    await updateDegradationState(60_000);
    expect(isDegraded()).toBe(true);

    // One good pass then back down: the recovery streak must reset so the
    // gateway stays degraded instead of exiting early.
    (await getDb().run("UPDATE api_keys SET status = 'healthy' WHERE platform = 'cloudflare'"));
    await updateDegradationState(60_001); // recovered pass starts streak
    (await getDb().run("UPDATE api_keys SET status = 'error' WHERE platform = 'cloudflare'"));
    await updateDegradationState(60_002); // down again — streak reset
    (await getDb().run("UPDATE api_keys SET status = 'healthy' WHERE platform IN ('cloudflare', 'mistral', 'openai')"));
    const afterLongRecovery = await updateDegradationState(60_002 + 120_000);
    expect(afterLongRecovery.state).toBe('degraded'); // exit streak restarted at 60_002
  });

  it('does not degrade when there are fewer providers than DEGRADED_MIN_PROVIDERS', async () => {
    await seedKey('groq', { status: 'healthy' });
    await seedKey('cloudflare', { status: 'error' });
    // Only 2 providers < default min of 3 → never degraded.
    const s = await updateDegradationState(0);
    await updateDegradationState(60_000);
    expect(s.state).toBe('normal');
    expect(isDegraded()).toBe(false);
  });

  it('getDegradationStatus returns the last snapshot without re-querying', async () => {
    await seedKey('groq', { status: 'healthy' });
    await updateDegradationState(0);
    const status = await getDegradationStatus();
    expect(status.totalProviders).toBe(1);
    expect(status.state).toBe('normal');
  });
});
