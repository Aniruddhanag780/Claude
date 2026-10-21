import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  getRoutingScores, refreshStatsCache, setProviderMomentAttribution,
} from '../../services/router.js';
import { getDb } from '../../db/index.js';
import { logRequest } from '../../lib/request-log.js';
import { initTestDb } from '../helpers/test-db.js';

// #1347 (PR 1): rows tagged 'provider_moment' are the provider's bad minute,
// not the model — with attribution ON they drop out of the reliability stats
// (denominator, failures, timeouts, speed). With it OFF (the default) every
// row counts and scoring is byte-identical to today.
async function addModel(platform: string, modelId: string): number {
  const db = getDb();
  (await db.run(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, 3, 1, 'Large', '~50M', 1, 0, 1) RETURNING id`, [platform, modelId, modelId.toUpperCase()]));
  return ((await db.get('SELECT id FROM models WHERE platform = ? AND model_id = ?', [platform, modelId])) as { id: number }).id;
}

async function scoreFor(modelDbId: number) {
  return (await getRoutingScores()).scores.find(s => s.modelDbId === modelDbId);
}

// 1 success, 1 ordinary failure, 1 attributed provider-moment failure —
// all logged this instant, so the day-0 decay weight is 1 for each.
async function seed() {
  await logRequest('groq', 'test-model', null, 'success', 100, 50, 12, null);
  await logRequest('groq', 'test-model', null, 'error', 30, 0, 9, 'API error 500: boom');
  await logRequest('groq', 'test-model', null, 'error', 30, 0, 9, 'API error 429: rate limit', null, null, null, null, 'provider_moment');
}

describe('provider-moment rows in the reliability stats (#1347 PR 1)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  beforeEach(async () => {
    delete process.env.ROUTER_PROVIDER_MOMENT_ATTRIBUTION;
    // Drop our rows only (requests first: they reference the model): the
    // seeded catalog's fallback_config rows would fail the FK on a blanket
    // DELETE FROM models.
    (await getDb().run('DELETE FROM requests'));
    const mine = (await getDb().get('SELECT id FROM models WHERE platform = ? AND model_id = ?', ['groq', 'test-model'])) as { id: number } | undefined;
    if (mine) (await getDb().run('DELETE FROM models WHERE id = ?', [mine.id]));
    await setProviderMomentAttribution(false);
  });

  it('feature OFF (default): every row counts, exactly as today', async () => {
    const id = await addModel('groq', 'test-model');
    await seed();
    await refreshStatsCache(getDb(), true);

    const score = await scoreFor(id);
    expect(score).toBeDefined();
    expect(score!.totalRequests).toBe(3);
    expect(score!.reliability).toBeLessThan(1);
  });

  it('feature ON: attributed rows drop out of the model books', async () => {
    const id = await addModel('groq', 'test-model');
    await seed();
    await refreshStatsCache(getDb(), true);
    const off = await scoreFor(id);

    await setProviderMomentAttribution(true); // force-refreshes the stats cache
    const on = await scoreFor(id);

    expect(on!.totalRequests).toBe(2);
    expect(on!.reliability).toBeGreaterThan(off!.reliability);
  });
});
