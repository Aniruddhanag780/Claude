import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../../db/index.js';
import { buildModelListing } from '../../services/model-listing.js';
import { setCooldown } from '../../services/ratelimit.js';
import { initTestDb } from '../helpers/test-db.js';

// #1100: /v1/models gains a per-model execution_status (ready / needsKey /
// exhausted) derived from whether the router could actually dispatch to the
// model right now, so agents can filter ?execution_status=ready and route
// around exhausted models instead of 429ing.

async function seedModel(platform: string, modelId: string, enabled = 1) {
  (await getDb().run(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, enabled)
    VALUES (?, ?, ?, 5, 5, 'Medium', NULL, NULL, NULL, NULL, '', ?) RETURNING id`, [platform, modelId, modelId, enabled]));
}

let keySeq = 0;
async function seedKey(platform: string, status: string, enabled = 1, scope: string[] | null = null) {
  keySeq += 1;
  return Number((await getDb().run(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, model_scope_json)
    VALUES (?, ?, 'x', 'x', 'x', ?, ?, ?) RETURNING id`, [platform, `${platform}-${status}-${keySeq}`, status, enabled, scope ? JSON.stringify(scope) : null])).lastInsertRowid);
}

async function statusFor(modelId: string) {
  const m = (await buildModelListing()).models.find(x => x.id === modelId);
  return m?.executionStatus;
}

describe('buildModelListing execution_status (#1100)', () => {
  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.UNIFY_MODELS = 'false';
    await initTestDb();
  });

  it('marks a model ready when a healthy enabled key exists', async () => {
    await seedModel('groq', 'ready-model');
    await seedKey('groq', 'healthy');
    expect(await statusFor('ready-model')).toBe('ready');
  });

  it('treats an unprobed (unknown) key as ready, not exhausted', async () => {
    await seedModel('groq', 'unknown-model');
    await seedKey('groq', 'unknown');
    expect(await statusFor('unknown-model')).toBe('ready');
  });

  it('marks a model needsKey when no enabled key exists', async () => {
    await seedModel('groq', 'nokey-model');
    expect(await statusFor('nokey-model')).toBe('needsKey');
  });

  it('marks a model exhausted when every candidate key is rate-limited or invalid', async () => {
    await seedModel('groq', 'exhausted-model');
    await seedKey('groq', 'rate_limited');
    await seedKey('groq', 'invalid');
    expect(await statusFor('exhausted-model')).toBe('exhausted');
  });

  it('stays ready when at least one of several keys is healthy', async () => {
    await seedModel('groq', 'mixed-model');
    await seedKey('groq', 'rate_limited');
    await seedKey('groq', 'healthy');
    expect(await statusFor('mixed-model')).toBe('ready');
  });

  it('marks a disabled model needsKey regardless of keys', async () => {
    await seedModel('groq', 'disabled-model', 0);
    await seedKey('groq', 'healthy');
    expect(await statusFor('disabled-model')).toBe('needsKey');
  });

  // A live 429 never writes api_keys.status: it writes a per-key cooldown row.
  // Reading status alone therefore called a cooling-down model ready.
  it('marks a model exhausted when its only key is on cooldown', async () => {
    await seedModel('groq', 'cooling-model');
    const keyId = await seedKey('groq', 'healthy');
    setCooldown('groq', 'cooling-model', keyId, 60_000, 'header');
    expect(await statusFor('cooling-model')).toBe('exhausted');
  });

  it('stays ready when a sibling key is not on cooldown', async () => {
    await seedModel('groq', 'sibling-model');
    const cooling = await seedKey('groq', 'healthy');
    await seedKey('groq', 'healthy');
    setCooldown('groq', 'sibling-model', cooling, 60_000, 'header');
    expect(await statusFor('sibling-model')).toBe('ready');
  });

  // #657: a key scoped to other models cannot serve this one, so it must not
  // make the model look ready.
  it('ignores a key scoped away from the model', async () => {
    await seedModel('groq', 'scoped-out-model');
    await seedKey('groq', 'healthy', 1, ['some-other-model']);
    expect(await statusFor('scoped-out-model')).toBe('exhausted');
  });

  it('counts a key scoped to the model itself', async () => {
    await seedModel('groq', 'scoped-in-model');
    await seedKey('groq', 'healthy', 1, ['scoped-in-model']);
    expect(await statusFor('scoped-in-model')).toBe('ready');
  });
});
