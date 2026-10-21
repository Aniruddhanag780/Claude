import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest, hasOtherUsableKey, setRoutingStrategy } from '../../services/router.js';
import { initTestDb } from '../helpers/test-db.js';

// Per-key model scopes (#657): a key whose model_scope_json is set must only
// ever serve the models it lists, and must not count as a usable sibling for
// models outside it. NULL scope is today's behavior, verbatim.
describe('Router model scope (#657)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  beforeEach(async () => {
    const db = getDb();
    // Deterministic manual order, same pinning the base router tests use.
    await setRoutingStrategy('priority');
    (await db.run('DELETE FROM api_keys'));
    (await db.run("DELETE FROM settings WHERE key = 'active_profile_id'"));
    const models = (await db.all('SELECT id FROM models ORDER BY intelligence_rank ASC')) as any[];
    for (let i = 0; i < models.length; i++) {
      (await db.run('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?', [i + 1, models[i].id]));
    }
  });

  async function insertKey(platform: string, secret: string, scope: string[] | string | null): number {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt(secret);
    const scopeJson = scope == null ? null : typeof scope === 'string' ? scope : JSON.stringify(scope);
    const result = (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, model_scope_json)
      VALUES (?, ?, ?, ?, ?, 'healthy', 1, ?) RETURNING id`, [platform, 'test', encrypted, iv, authTag, scopeJson]));
    return Number(result.lastInsertRowid);
  }

  async function googleModels(): { id: number; model_id: string }[] {
    return (await getDb().all('SELECT id, model_id FROM models WHERE platform = ? AND enabled = 1 ORDER BY intelligence_rank ASC', ['google'])) as { id: number; model_id: string }[];
  }

  it('a NULL scope serves every model of the platform (regression)', async () => {
    await insertKey('google', 'unscoped-key', null);
    const result = await routeRequest();
    expect(result.platform).toBe('google');
    expect(result.apiKey).toBe('unscoped-key');
    expect(result.modelId).toBe(await googleModels()[0]!.model_id);
  });

  it('excludes a model whose only key is scoped to other models', async () => {
    await insertKey('google', 'scoped-away', ['some-model-this-platform-does-not-have']);
    await insertKey('groq', 'groq-key', null);
    // Google outranks Groq in the manual order, but its only key cannot serve
    // any Google model — the router must fall through instead of burning an
    // attempt on a guaranteed 403.
    const result = await routeRequest();
    expect(result.platform).toBe('groq');
  });

  it('routes a scoped key only to the model in its scope', async () => {
    const [top, second] = await googleModels();
    expect(second).toBeDefined();
    await insertKey('google', 'scoped-key', [second!.model_id]);
    const result = await routeRequest();
    expect(result.platform).toBe('google');
    expect(result.modelId).toBe(second!.model_id);
    expect(result.modelId).not.toBe(top!.model_id);
  });

  it('treats an empty or corrupt stored scope as unscoped', async () => {
    await insertKey('google', 'empty-scope', '[]');
    expect((await routeRequest()).modelId).toBe(await googleModels()[0]!.model_id);

    (await getDb().run('DELETE FROM api_keys'));
    await insertKey('google', 'corrupt-scope', 'not json');
    expect((await routeRequest()).modelId).toBe(await googleModels()[0]!.model_id);
  });

  describe('hasOtherUsableKey', () => {
    it('does not count a sibling scoped away from the model', async () => {
      const top = await googleModels()[0]!;
      const failedKeyId = await insertKey('google', 'failed-key', null);
      await insertKey('google', 'scoped-sibling', ['some-other-model']);
      // The only sibling can never serve this model, so the model IS exhausted
      // and the model-level penalty must not be suppressed (#454 gate).
      expect(await hasOtherUsableKey(top.id, failedKeyId)).toBe(false);
    });

    it('counts a sibling whose scope includes the model', async () => {
      const top = await googleModels()[0]!;
      const failedKeyId = await insertKey('google', 'failed-key', null);
      await insertKey('google', 'in-scope-sibling', [top.model_id]);
      expect(await hasOtherUsableKey(top.id, failedKeyId)).toBe(true);
    });

    it('counts an unscoped sibling (regression)', async () => {
      const top = await googleModels()[0]!;
      const failedKeyId = await insertKey('google', 'failed-key', null);
      await insertKey('google', 'unscoped-sibling', null);
      expect(await hasOtherUsableKey(top.id, failedKeyId)).toBe(true);
    });
  });
});
