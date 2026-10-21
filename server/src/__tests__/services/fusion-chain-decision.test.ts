import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { clearAllCooldowns } from '../../services/ratelimit.js';
import { clientContextMiddleware, setRequestRoutingStrategy } from '../../lib/client-context.js';
import { getOrderedFusionChain, refreshStatsCache, setRoutingStrategy } from '../../services/router.js';
import { seedDecisionModels } from '../helpers/decision-models.js';
import { initTestDb } from '../helpers/test-db.js';

// #1354 follow-up: with the 'decision' strategy active, the fusion panel's
// auto-pick (getOrderedFusionChain) must follow the preset the decision model
// picked for THIS request — the same effectiveRoutingStrategy() seam the chat
// router already uses. Reading the raw setting instead scored every
// decision-strategy request as plain Balanced, so a 'smartest' request got its
// chat answer from the big model and its panel slots from the Balanced order.

async function addKey(platform: string, raw = `${platform}-test-key`): void {
  const { encrypted, iv, authTag } = encrypt(raw);
  (await getDb().run(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'fusion-decision', ?, ?, ?, 'healthy', 1) RETURNING id`, [platform, encrypted, iv, authTag]));
}

async function addModel(modelId: string, sizeLabel: string, speedRank: number): void {
  const db = getDb();
  const id = Number((await db.run(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES ('groq', ?, ?, 1, ?, ?, '~1M', 128000, 1, 0, 1) RETURNING id`, [modelId, modelId, speedRank, sizeLabel])).lastInsertRowid);
  (await db.run('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1) RETURNING id', [id, id]));
  const profile = (await db.get("SELECT value FROM settings WHERE key = 'active_profile_id'")) as { value: string } | undefined;
  if (profile) {
    (await db.run('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1) RETURNING id', [Number(profile.value), id, id]));
  }
}

async function seedHistory(modelId: string, latencyMs: number, ttfbMs: number): void {
  for (let i = 0; i < 20; i++) (await getDb().run(`
    INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms)
    VALUES ('groq', ?, 'success', 50, 300, ?, ?) RETURNING id`, [modelId, latencyMs, ttfbMs]));
}

/** Run `fn` inside a request scope, optionally pre-tagged with a decision pick. */
function inRequest<T>(strategy: 'smartest' | 'fastest' | undefined, fn: () => T): T {
  const req = { headers: {}, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
  let out!: T;
  clientContextMiddleware(req, {} as Response, () => {
    if (strategy) setRequestRoutingStrategy(strategy);
    out = fn();
  });
  return out;
}

describe('fusion panel chain under decision routing (#1354)', () => {
  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
    (await getDb().run('UPDATE models SET enabled = 0'));
    await addModel('big-slow', 'Frontier', 11);
    await addModel('small-fast', 'Small', 1);
    await seedHistory('big-slow', 15_000, 4_000);
    await seedHistory('small-fast', 400, 100);
    await refreshStatsCache(getDb(), true);
    await seedDecisionModels();
    await addKey('groq', 'gsk-fusion-decision');
    await clearAllCooldowns(Number.MAX_SAFE_INTEGER);
    await setRoutingStrategy('decision');
  });

  afterEach(async () => {
    await setRoutingStrategy('balanced');
  });

  const firstModelId = (strategy: 'smartest' | 'fastest' | undefined) => {
    const chain = inRequest(strategy, async () => await getOrderedFusionChain(1000));
    return chain[0]?.modelId;
  };

  it('orders the panel chain by the preset picked for the request, not the raw setting', () => {
    // A 'smartest' request puts the big model first; a 'fastest' one the small
    // model. If the panel read the raw 'decision' setting both calls would fall
    // back to Balanced and the two orders would be identical.
    expect(firstModelId('smartest')).toBe('big-slow');
    expect(firstModelId('fastest')).toBe('small-fast');
  });

  it('outside any request scope, decision scores as Balanced (the documented fallback)', async () => {
    // With these ranks the Balanced preset scores the frontier model first —
    // the point is that the call is accepted and deterministic outside a
    // request scope, exactly like the weightsWithPeak('balanced') fallthrough.
    const chain = await getOrderedFusionChain(1000);
    expect(chain[0]?.modelId).toBe('big-slow');
  });
});
