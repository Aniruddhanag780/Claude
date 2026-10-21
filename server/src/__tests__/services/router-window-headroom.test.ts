import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { getRoutingScores, refreshStatsCache, setHeadroomThresholds } from '../../services/router.js';
import { invalidateWindowUsage, modelWindowUsedFraction } from '../../services/ratelimit.js';
import { initTestDb } from '../helpers/test-db.js';

// #899: the headroom guardrail used to have an opinion only about models that
// declare a monthly_token_budget. A model capped by rpd/tpd was binary-gated —
// full score until the request that finally 429s it. These tests pin the graded
// behaviour: demotion as the window fills, no opinion while it is empty,
// automatic recovery when the window rolls, and operator-tunable thresholds.
describe('rate-window headroom guardrail (#899)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let busy: { id: number; modelId: string };
  let idle: { id: number; modelId: string };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
    const db = getDb();

    const rows = (await db.all("SELECT id, model_id FROM models WHERE platform = 'groq' ORDER BY id LIMIT 2")) as { id: number; model_id: string }[];
    expect(rows.length).toBe(2);
    [busy, idle] = rows.map(r => ({ id: r.id, modelId: r.model_id }));

    // Two peers that differ ONLY in window utilization: same tier and rank so
    // the intelligence axis ties, no monthly budget so that guardrail stays out
    // of it, and the same daily request cap.
    for (const m of rows) {
      (await db.run(`
        UPDATE models
           SET monthly_token_budget = '', rpd_limit = 100, rpm_limit = NULL,
               tpm_limit = NULL, tpd_limit = NULL,
               size_label = 'medium', intelligence_rank = 10
         WHERE id = ?
      `, [m.id]));
    }
    // Every other model out of the chain, so the two peers are the whole
    // ranking and the intelligence normalization cannot reorder them.
    (await db.run("UPDATE models SET enabled = 0 WHERE id NOT IN (?, ?)", [busy.id, idle.id]));

    const { encrypted, iv, authTag } = encrypt('groq-key');
    (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'k0', ?, ?, ?, 'healthy', 1) RETURNING id`, [encrypted, iv, authTag]));
  });

  beforeEach(async () => {
    (await getDb().run('DELETE FROM rate_limit_usage'));
    await setHeadroomThresholds(null, null);
    invalidateWindowUsage();
  });

  async function keyId(): number {
    return ((await getDb().get("SELECT id FROM api_keys WHERE platform = 'groq'")) as { id: number }).id;
  }

  /** n recorded requests for `modelId`, aged `ageMs` into the past. */
  async function recordRequests(modelId: string, n: number, ageMs = 0) {
    const db = getDb();
    const at = Date.now() - ageMs;
    for (let i = 0; i < n; i++) (await db.run(`
      INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
      VALUES ('groq', ?, ?, 'request', 0, ?) RETURNING id`, [modelId, keyId(), at]));
    invalidateWindowUsage();
  }

  async function headroomOf(modelDbId: number): number {
    await refreshStatsCache(getDb(), true);
    const { scores } = await getRoutingScores();
    const row = scores.find(s => s.modelDbId === modelDbId);
    if (!row) throw new Error('model missing from routing scores');
    return row.headroom;
  }

  async function scoreOf(modelDbId: number): number {
    await refreshStatsCache(getDb(), true);
    const { scores } = await getRoutingScores();
    const row = scores.find(s => s.modelDbId === modelDbId);
    if (!row) throw new Error('model missing from routing scores');
    return row.score;
  }

  it('leaves an untouched model alone (factor 1)', async () => {
    expect(await headroomOf(busy.id)).toBe(1);
    expect(await headroomOf(idle.id)).toBe(1);
  });

  it('still has no opinion at low utilization, below the ramp', async () => {
    recordRequests(busy.modelId, 50); // 50% of RPD — 50% left, ramp starts at 20%
    expect(await headroomOf(busy.id)).toBe(1);
  });

  it('demotes a model at 95% of its RPD below an idle peer', async () => {
    recordRequests(busy.modelId, 95);
    const busyHeadroom = await headroomOf(busy.id);
    expect(busyHeadroom).toBeLessThan(1);
    // 5% remaining, ramp 20%, floor 0.1 → 0.1 + 0.9·(0.05/0.2) = 0.325
    expect(busyHeadroom).toBeCloseTo(0.325, 5);
    expect(await headroomOf(idle.id)).toBe(1);
    expect(await scoreOf(busy.id)).toBeLessThan(await scoreOf(idle.id));

    // And the ranking actually flips — the busy model is no longer first.
    const { scores } = await getRoutingScores();
    expect(scores[0].modelDbId).toBe(idle.id);
  });

  it('recovers on its own once the day window rolls past the usage', async () => {
    recordRequests(busy.modelId, 95);
    expect(await headroomOf(busy.id)).toBeLessThan(1);

    // Age the same rows out of the sliding day. Nothing resets a counter — the
    // window simply stops counting them.
    (await getDb().run("UPDATE rate_limit_usage SET created_at_ms = ? WHERE model_id = ?", [Date.now() - DAY_MS - 60_000, busy.modelId]));
    invalidateWindowUsage();

    expect(await headroomOf(busy.id)).toBe(1);
    expect(await scoreOf(busy.id)).toBeCloseTo(await scoreOf(idle.id), 10);
  });

  it('honours the tunable thresholds from the settings API', async () => {
    recordRequests(busy.modelId, 60); // 40% left — outside the 20% default ramp
    expect(await headroomOf(busy.id)).toBe(1);

    // Operator asks to start protecting at 50% remaining with a 0.3 floor.
    await setHeadroomThresholds(0.5, 0.3);
    invalidateWindowUsage();
    // 0.3 + 0.7·(0.4/0.5) = 0.86
    expect(await headroomOf(busy.id)).toBeCloseTo(0.86, 5);
    expect(await headroomOf(idle.id)).toBe(1);
  });

  it('takes the busiest window across rpd and tpd', async () => {
    const db = getDb();
    (await db.run("UPDATE models SET tpd_limit = 1000 WHERE id = ?", [busy.id]));
    recordRequests(busy.modelId, 10); // only 10% of RPD
    (await db.run(`
      INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
      VALUES ('groq', ?, ?, 'tokens', 900, ?) RETURNING id`, [busy.modelId, await keyId(), Date.now()]));
    invalidateWindowUsage();

    // 90% of TPD binds, not 10% of RPD.
    expect(await headroomOf(busy.id)).toBeCloseTo(0.55, 5); // 0.1 + 0.9·(0.1/0.2)
    (await db.run("UPDATE models SET tpd_limit = NULL WHERE id = ?", [busy.id]));
  });

  it('follows the eligible key with the most headroom, not the worst one', async () => {
    const db = getDb();
    const second = encrypt('groq-key-2');
    (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'k1', ?, ?, ?, 'healthy', 1) RETURNING id`, [second.encrypted, second.iv, second.authTag]));
    const ids = ((await db.all("SELECT id FROM api_keys WHERE platform = 'groq' ORDER BY id")) as { id: number }[]).map(r => r.id);

    for (let i = 0; i < 99; i++) (await db.run(`
      INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
      VALUES ('groq', ?, ?, 'request', 0, ?) RETURNING id`, [busy.modelId, ids[0], Date.now()]));
    invalidateWindowUsage();

    // One key is all but exhausted; the other is untouched, and the router will
    // land on it, so the model is not under any real pressure.
    expect(await headroomOf(busy.id)).toBe(1);
    (await db.run('DELETE FROM api_keys WHERE id = ?', [ids[1]]));
    invalidateWindowUsage();
  });

  it('has no opinion for a model that declares no window limits', async () => {
    (await getDb().run("UPDATE models SET rpd_limit = NULL WHERE id = ?", [busy.id]));
    recordRequests(busy.modelId, 500);
    expect(await modelWindowUsedFraction(
      { platform: 'groq', modelId: busy.modelId, keyId: null },
      { rpm: null, rpd: null, tpm: null, tpd: null },
    )).toBeNull();
    expect(await headroomOf(busy.id)).toBe(1);
    (await getDb().run("UPDATE models SET rpd_limit = 100 WHERE id = ?", [busy.id]));
  });
});
