import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  routeRequest, refreshStatsCache, setRoutingStrategy,
  recordRateLimitHit, recordSuccess,
} from '../../services/router.js';
import { getDb } from '../../db/index.js';
import { addToActiveChain } from '../helpers/chain.js';
import { initTestDb } from '../helpers/test-db.js';

vi.mock('../../services/ratelimit.js', async () => {
  const actual = await vi.importActual('../../services/ratelimit.js');
  return {
    ...actual,
    canMakeRequest: vi.fn(() => true),
    canUseTokens: vi.fn(() => true),
    isOnCooldown: vi.fn(() => false),
  };
});

vi.mock('../../lib/crypto.js', async () => {
  const actual = await vi.importActual('../../lib/crypto.js');
  return { ...actual, decrypt: vi.fn(() => 'mocked-api-key') };
});

const ORIGINAL_DEV_MODE = process.env.DEV_MODE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

// Track every model we penalize so afterEach can drain it: the penalty map is
// module-level state that outlives the in-memory db, and ids restart at 1 for
// each fresh db — a leaked penalty would land on an unrelated model next test.
const penalized: number[] = [];

function penalize(modelDbId: number, hits: number) {
  for (let i = 0; i < hits; i++) recordRateLimitHit(modelDbId);
  penalized.push(modelDbId);
}

async function addModel(opts: { platform: string; modelId: string; priority: number }): number {
  const db = getDb();
  (await db.run(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, 3, 1, 'Large', '~50M', 1, 0, 1) RETURNING id`, [opts.platform, opts.modelId, opts.modelId.toUpperCase()]));
  const id = ((await db.get('SELECT id FROM models WHERE platform = ? AND model_id = ?', [opts.platform, opts.modelId])) as { id: number }).id;
  (await db.run('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1) RETURNING id', [id, opts.priority]));
  await addToActiveChain(id, opts.priority);
  (await db.run(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'k', 'enc', 'iv', 'tag', 'healthy', 1) RETURNING id`, [opts.platform]));
  return id;
}

describe('priority-mode routing penalty under spaced priorities', () => {
  beforeEach(async () => {
    process.env.DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    await initTestDb();
    getDb().exec('DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests;');
    vi.clearAllMocks();
    await setRoutingStrategy('priority');
  });

  afterEach(() => {
    // MAX_PENALTY is 10 and recordSuccess decrements by 1, so 12 drains any entry.
    for (const id of penalized) for (let i = 0; i < 12; i++) recordSuccess(id);
    penalized.length = 0;
    if (ORIGINAL_DEV_MODE === undefined) delete process.env.DEV_MODE; else process.env.DEV_MODE = ORIGINAL_DEV_MODE;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  // The bug: the penalty is denominated in priority POSITIONS and capped at 10,
  // so adding it to the raw priority could never reorder a chain the user (or
  // the enabled-model filter) had spaced wider than that. A model 429-ing every
  // request stayed pinned at the head of the chain forever.
  it('demotes a penalized model even when priorities are spaced 10/20/30', async () => {
    const a = await addModel({ platform: 'google', modelId: 'a', priority: 10 });
    await addModel({ platform: 'groq', modelId: 'b', priority: 20 });
    await addModel({ platform: 'cerebras', modelId: 'c', priority: 30 });
    await refreshStatsCache(getDb(), true);

    expect((await routeRequest(100)).modelId).toBe('a');

    // One 429 costs PENALTY_PER_429 = 3 positions: rank 1 + 3 = 4, behind b's 2.
    penalize(a, 1);
    expect((await routeRequest(100)).modelId).toBe('b');
  });

  it('demotes a penalized model when the enabled subset leaves holes in the sequence', async () => {
    // The realistic shape: the catalog was numbered 1..N densely, then most
    // models were switched off, leaving the survivors far apart.
    const a = await addModel({ platform: 'google', modelId: 'a', priority: 3 });
    await addModel({ platform: 'groq', modelId: 'b', priority: 87 });
    await refreshStatsCache(getDb(), true);

    expect((await routeRequest(100)).modelId).toBe('a');
    penalize(a, 1);
    expect((await routeRequest(100)).modelId).toBe('b');
  });

  it('leaves an unpenalized chain in exactly the order the user arranged', async () => {
    await addModel({ platform: 'google', modelId: 'a', priority: 30 });
    await addModel({ platform: 'groq', modelId: 'b', priority: 10 });
    await addModel({ platform: 'cerebras', modelId: 'c', priority: 20 });
    await refreshStatsCache(getDb(), true);

    expect((await routeRequest(100)).modelId).toBe('b');
  });

  it('keeps a dense chain behaving exactly as before', async () => {
    const a = await addModel({ platform: 'google', modelId: 'a', priority: 1 });
    await addModel({ platform: 'groq', modelId: 'b', priority: 2 });
    await refreshStatsCache(getDb(), true);

    expect((await routeRequest(100)).modelId).toBe('a');
    penalize(a, 1);
    expect((await routeRequest(100)).modelId).toBe('b');
  });

  it('does not demote past a model penalized even harder', async () => {
    const a = await addModel({ platform: 'google', modelId: 'a', priority: 10 });
    const b = await addModel({ platform: 'groq', modelId: 'b', priority: 20 });
    await addModel({ platform: 'cerebras', modelId: 'c', priority: 30 });
    await refreshStatsCache(getDb(), true);

    penalize(a, 1);  // rank 1 + 3 = 4
    penalize(b, 3);  // rank 2 + 9 = 11
    // c is unpenalized at rank 3 — the cheapest of the three.
    expect((await routeRequest(100)).modelId).toBe('c');
  });
});
