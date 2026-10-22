import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../../db/index.js';
import {
  resolveModelGroupCandidates,
  routeRequest,
  refreshStatsCache,
  setRoutingStrategy,
} from '../../services/router.js';
import { encrypt } from '../../lib/crypto.js';
import { initTestDb } from '../helpers/test-db.js';

// A slug-only match is a FALLBACK, not an equal candidate (#651). The router
// re-orders whatever chain it is handed by live score, so the tier has to be
// expressed as something orderChain honours as a TIER — otherwise a
// coincidental slug sibling with better recent numbers silently answers a
// request that named a different model literally.

async function addKey(platform: string): Promise<number> {
  const { encrypted, iv, authTag } = encrypt(`${platform}-secret`);
  const r = (await getDb().run(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1) RETURNING id`, [platform, platform, encrypted, iv, authTag]));
  return Number(r.lastInsertRowid);
}

async function addModel(platform: string, modelId: string): Promise<number> {
  const r = (await getDb().run(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source)
    VALUES (?, ?, ?, 50, 50, 1, 'catalog') RETURNING id`, [platform, modelId, modelId]));
  return Number(r.lastInsertRowid);
}

/** Give one (model, key) a spotless record so its bandit score is high. */
async function logSuccesses(platform: string, modelId: string, keyId: number, n: number) {
  for (let i = 0; i < n; i++) (await getDb().run(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, request_type)
    VALUES (?, ?, ?, 'success', 100, 400, 200, 'chat') RETURNING id`, [platform, modelId, keyId]));
}

async function logFailures(platform: string, modelId: string, keyId: number, n: number) {
  for (let i = 0; i < n; i++) (await getDb().run(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type)
    VALUES (?, ?, ?, 'error', 100, 0, 30000, 'upstream timeout', 'chat') RETURNING id`, [platform, modelId, keyId]));
}

describe('slug-match demotion survives the router', () => {
  let literalId: number;
  let slugId: number;

  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
    (await getDb().run("DELETE FROM settings WHERE key = 'active_profile_id'"));
    (await getDb().run('DELETE FROM api_keys'));
    await setRoutingStrategy('balanced');

    const groqKey = await addKey('groq');
    const cerebrasKey = await addKey('cerebras');
    literalId = await addModel('groq', 'tier-test-model');
    slugId = await addModel('cerebras', 'tier-test-other');

    // The fallback candidate is measurably BETTER than the literal one, so
    // score alone would put it first.
    await logFailures('groq', 'tier-test-model', groqKey, 30);
    await logSuccesses('cerebras', 'tier-test-other', cerebrasKey, 40);
    await refreshStatsCache(getDb(), true);
  });

  it('orders a demoted member behind a literal one despite a better score', async () => {
    const chain = await resolveModelGroupCandidates([literalId, slugId], new Set([slugId]));
    expect(chain.map(c => c.model_db_id)).toEqual([literalId, slugId]);
  });

  it('still dispatches to the literal model when the router re-sorts the chain', async () => {
    // routeRequest runs its own orderChain over the prefetched chain, which is
    // where a tier expressed as mere ordering would be lost.
    const chain = await resolveModelGroupCandidates([literalId, slugId], new Set([slugId]));
    const route = await routeRequest(1000, undefined, undefined, false, false, undefined, chain);
    expect(route.modelDbId).toBe(literalId);
    route.release?.();
  });

  it('falls through to the demoted member once the literal one is ruled out', async () => {
    const chain = await resolveModelGroupCandidates([literalId, slugId], new Set([slugId]));
    const route = await routeRequest(1000, undefined, undefined, false, false, new Set([literalId]), chain);
    expect(route.modelDbId).toBe(slugId);
    route.release?.();
  });

  it('leaves an untiered chain ordered purely by score', async () => {
    const chain = await resolveModelGroupCandidates([literalId, slugId]);
    expect(chain.map(c => c.model_db_id)).toEqual([slugId, literalId]);
  });
});
