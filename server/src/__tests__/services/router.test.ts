import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  getAllPenalties,
  recordRateLimitHit,
  routeRequest,
  setRoutingStrategy,
} from '../../services/router.js';
import { setCooldown } from '../../services/ratelimit.js';
import { initTestDb } from '../helpers/test-db.js';

describe('Router', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  beforeEach(async () => {
    const db = getDb();
    // These cases assert the manual priority order specifically; pin it so the
    // bandit (now the default strategy) doesn't reorder by score.
    await setRoutingStrategy('priority');
    (await db.run('DELETE FROM api_keys'));
    // Disable active profile so the router falls back to fallback_config
    (await db.run("DELETE FROM settings WHERE key = 'active_profile_id'"));
    // Reset fallback order to intelligence ranking
    const models = (await db.all('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC')) as any[];
    for (let i = 0; i < models.length; i++) {
      (await db.run('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?', [i + 1, models[i].id]));
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should throw when no keys are configured', async () => {
    await expect(routeRequest()).rejects.toThrow(/exhausted/i);
  });

  it('should route to highest priority model with available key', async () => {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt('test-groq-key');
    (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, ['groq', 'test', encrypted, iv, authTag, 'healthy', 1]));

    const result = await routeRequest();
    expect(result.platform).toBe('groq');
    expect(result.apiKey).toBe('test-groq-key');
  });

  it('should prefer higher-priority model when keys exist for multiple platforms', async () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, ['google', 'test', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 1]));

    const groqKey = encrypt('test-groq-key');
    (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, ['groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1]));

    // Post-V6: Google's gemini-3.1-pro-preview (rank 1, free-tier-eligible per
    // probe on 2026-04-25) outranks Groq's best free-tier model openai/gpt-oss-120b
    // (rank 6). With keys for both platforms, Google wins.
    const result = await routeRequest();
    expect(result.platform).toBe('google');
  });

  it('should skip disabled keys', async () => {
    const db = getDb();

    const googleKey = encrypt('test-google-key');
    (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, ['google', 'disabled', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 0]));

    const groqKey = encrypt('test-groq-key');
    (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, ['groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1]));

    const result = await routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('should skip invalid keys', async () => {
    const db = getDb();

    const invalidKey = encrypt('invalid-key');
    (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, ['google', 'invalid', invalidKey.encrypted, invalidKey.iv, invalidKey.authTag, 'invalid', 1]));

    const groqKey = encrypt('test-groq-key');
    (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, ['groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1]));

    const result = await routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('skips a model whose context window cannot hold the request (#167)', async () => {
    const db = getDb();
    const groqKey = encrypt('test-groq-key');
    (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, ['groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1]));

    // Remove token rate-limit interference so we isolate the context-window
    // behavior (canUseTokens would otherwise also skip on a large estimate).
    (await db.run("UPDATE models SET tpm_limit = NULL, tpd_limit = NULL WHERE platform = 'groq'"));

    // Whatever model a small request lands on, give it a tiny context window.
    const baseline = await routeRequest(5);
    (await db.run('UPDATE models SET context_window = 10 WHERE id = ?', [baseline.modelDbId]));

    // A small request still lands on it (5 < 10) ...
    expect((await routeRequest(5)).modelDbId).toBe(baseline.modelDbId);

    // ... but a request larger than its window is routed elsewhere (2000 > 10).
    const large = await routeRequest(2000);
    expect(large.modelDbId).not.toBe(baseline.modelDbId);
  });

  it('prefers margin-fitting models but still serves raw-window fits (#956 review)', async () => {
    const db = getDb();
    const groqKey = encrypt('test-groq-key');
    (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, ['groq', 'groq', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1]));

    const groq = (await db.get(`
      SELECT id FROM models
       WHERE platform = 'groq' AND context_window = 131072
       LIMIT 1
    `)) as { id: number };

    (await db.run('UPDATE fallback_config SET priority = 1000, enabled = 1'));
    (await db.run('UPDATE fallback_config SET priority = 1 WHERE model_db_id = ?', [groq.id]));
    (await db.run('UPDATE models SET tpm_limit = NULL, tpd_limit = NULL WHERE id = ?', [groq.id]));

    // CONTEXT_WINDOW_SAFETY_FACTOR: the chars/4 estimate under-counts dense
    // payloads (JSON, code), so the preferred ceiling is window / 1.25.
    // 131072 / 1.25 = 104857.6. A margin-fitting runner-up on another platform
    // must NOT outrank the priority-1 model while the estimate is inside the
    // margin.
    const googleKey = encrypt('test-google-key');
    (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, ['google', 'google', googleKey.encrypted, googleKey.iv, googleKey.authTag, 'healthy', 1]));
    const google = (await db.get(`
      SELECT id FROM models
       WHERE platform = 'google' AND context_window >= 132500 AND enabled = 1
       ORDER BY intelligence_rank ASC
       LIMIT 1
    `)) as { id: number };
    expect(google).toBeDefined();
    (await db.run('UPDATE fallback_config SET priority = 2 WHERE model_db_id = ?', [google.id]));
    (await db.run('UPDATE models SET tpm_limit = NULL, tpd_limit = NULL WHERE id = ?', [google.id]));

    expect((await routeRequest(104000)).modelDbId).toBe(groq.id);

    // Above the margin ceiling the priority-1 model is DEMOTED, not excluded:
    // /v1/models advertises the raw window, so a client that packs past the
    // margin gets the margin-fitting runner-up instead of "all models exhausted".
    expect((await routeRequest(106000)).modelDbId).not.toBe(groq.id);
    expect((await routeRequest(106000)).modelDbId).toBe(google.id);

    // When nothing fits WITH the margin anywhere, the raw advertised window is
    // still honored — one attempt rather than an empty pool.
    (await db.run("DELETE FROM api_keys WHERE platform = 'google'"));
    expect((await routeRequest(106000)).modelDbId).toBe(groq.id);
  });

  it('still routes a model with an unknown (null) context window (#167)', async () => {
    const db = getDb();
    const groqKey = encrypt('test-groq-key');
    (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, ['groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1]));
    (await db.run("UPDATE models SET tpm_limit = NULL, tpd_limit = NULL WHERE platform = 'groq'"));
    // A null context_window means "unknown" — never filtered out, even for a huge request.
    (await db.run("UPDATE models SET context_window = NULL WHERE platform = 'groq'"));
    await expect(routeRequest(500000)).resolves.toBeDefined();
  });

  it('should skip keys that cannot be decrypted and use a valid fallback key', async () => {
    const db = getDb();

    (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, ['google', 'corrupt', 'not-hex', 'not-hex', 'not-hex', 'healthy', 1]));

    const groqKey = encrypt('test-groq-key');
    (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, ['groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1]));

    const result = await routeRequest();
    const corruptKey = (await db.get("SELECT status FROM api_keys WHERE label = 'corrupt'")) as { status: string };

    expect(result.platform).toBe('groq');
    expect(result.apiKey).toBe('test-groq-key');
    expect(corruptKey.status).toBe('error');
  });

  it('applies elapsed decay before adding a new 429 penalty', () => {
    vi.useFakeTimers();
    const modelDbId = 987654321;

    recordRateLimitHit(modelDbId);
    vi.advanceTimersByTime(10 * 60 * 1000);
    recordRateLimitHit(modelDbId);

    expect(getAllPenalties()).toContainEqual({
      modelDbId,
      count: 2,
      penalty: 3,
    });
  });
});

describe('Router explicit pin vs upstream retirement (#1394)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  beforeEach(async () => {
    const db = getDb();
    await setRoutingStrategy('priority');
    (await db.run('DELETE FROM api_keys'));
    (await db.run("DELETE FROM settings WHERE key = 'active_profile_id'"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not inject a pinned model carrying an upstream_eol tombstone into the chain', async () => {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt('test-groq-key');
    (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, ['groq', 'test', encrypted, iv, authTag, 'healthy', 1]));

    // Retire a groq model upstream: chain off + tombstone, row stays enabled=1
    // (the documented retirement contract).
    const target = (await db.get("SELECT id, model_id FROM models WHERE platform = 'groq' AND enabled = 1 ORDER BY intelligence_rank ASC LIMIT 1")) as { id: number; model_id: string };
    (await db.run('UPDATE fallback_config SET enabled = 0 WHERE model_db_id = ?', [target.id]));
    (await db.run(`
      INSERT INTO catalog_model_tombstones (kind, platform, model_id, source, reason, created_at)
      VALUES ('chat', 'groq', ?, 'upstream_eol', 'HTTP 410 end of life', to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS'))
    `, [target.model_id]));

    // The pin must not re-add it: the request routes to some OTHER groq model,
    // never to the retired one.
    const result = await routeRequest(1000, undefined, target.id);
    expect(result.modelDbId).not.toBe(target.id);
  });

  it('still pins a model whose tombstone is from the user, not upstream', async () => {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt('test-groq-key');
    (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, ['groq', 'test', encrypted, iv, authTag, 'healthy', 1]));

    const target = (await db.get("SELECT id, model_id FROM models WHERE platform = 'groq' AND enabled = 1 ORDER BY intelligence_rank DESC LIMIT 1")) as { id: number; model_id: string };
    (await db.run('UPDATE fallback_config SET enabled = 0 WHERE model_db_id = ?', [target.id]));
    (await db.run(`
      INSERT INTO catalog_model_tombstones (kind, platform, model_id, source, reason, created_at)
      VALUES ('chat', 'groq', ?, 'user', 'removed in dashboard', to_char((now() at time zone 'utc'), 'YYYY-MM-DD HH24:MI:SS'))
    `, [target.model_id]));

    const result = await routeRequest(1000, undefined, target.id);
    expect(result.modelDbId).toBe(target.id);
  });
});

describe('Router exhaustion diagnostics (issue _1)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  beforeEach(async () => {
    const db = getDb();
    await setRoutingStrategy('priority');
    (await db.run('DELETE FROM api_keys'));
    (await db.run("DELETE FROM settings WHERE key = 'active_profile_id'"));
    (await db.run('DELETE FROM rate_limit_cooldowns'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('attaches a non-empty per-model disposition to the exhaustion error', async () => {
    // No keys configured → every chain model is unroutable. The thrown error
    // must carry diagnostics so the synchronous routing_error is debuggable
    // instead of opaque (the failure that NOTHING else logs).
    let caught: any;
    try { await routeRequest(); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(Array.isArray(caught.diagnostics)).toBe(true);
    expect(caught.diagnostics.length).toBeGreaterThan(0);
    // Every entry is "<platform>/<model>: <reason>"; with no keys the reason is
    // the platform having no enabled+healthy key.
    expect(caught.diagnostics.every((d: string) => d.includes(': '))).toBe(true);
    expect(caught.diagnostics.some((d: string) => /no enabled.*key/i.test(d))).toBe(true);
  });

  it('records cooldown as the skip reason for a benched key', async () => {
    const db = getDb();
    const groqKey = encrypt('test-groq-key');
    (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`, ['groq', 'test', groqKey.encrypted, groqKey.iv, groqKey.authTag, 'healthy', 1]));

    // Bench every groq model on this key, so the only configured provider is
    // fully cooled down and the pool empties with a key present (not absent).
    const keyId = ((await db.get("SELECT id FROM api_keys WHERE platform='groq'")) as { id: number }).id;
    const groqModels = (await db.all("SELECT model_id FROM models WHERE platform='groq' AND enabled=1")) as { model_id: string }[];
    for (const m of groqModels) setCooldown('groq', m.model_id, keyId, 5 * 60 * 1000);

    let caught: any;
    try { await routeRequest(); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.diagnostics.some((d: string) => /cooldown/.test(d))).toBe(true);
  });
});
