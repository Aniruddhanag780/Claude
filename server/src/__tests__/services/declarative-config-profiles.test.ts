import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../db/index.js';
import { applyDeclarativeConfig } from '../../services/declarative-config.js';
import { resolveRoutingChain } from '../../services/router.js';
import { initTestDb } from '../helpers/test-db.js';

/**
 * A model needs a row in BOTH fallback_config and profile_models to be routable:
 * once a profile is active the router reads profile_models. routes/keys.ts calls
 * ensureModelInProfiles after its chain insert; declarative config did not, so an
 * env-configured custom model showed up in the dashboard and was never selected.
 */
describe('declarative config keeps profile membership in sync', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  beforeEach(async () => {
    const db = getDb();
    // Children first: fallback_config and profile_models both reference models.id.
    (await db.run("DELETE FROM profile_models WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom')"));
    (await db.run("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom')"));
    (await db.run("DELETE FROM models WHERE platform = 'custom'"));
    (await db.run('DELETE FROM api_keys'));
  });

  async function profileRowCount(modelDbId: number): number {
    return ((await getDb().get('SELECT COUNT(*) AS n FROM profile_models WHERE model_db_id = ?', [modelDbId])) as { n: number }).n;
  }

  it('adds a declaratively-registered custom model to every profile', async () => {
    const db = getDb();
    const profileCount = ((await db.get('SELECT COUNT(*) AS n FROM profiles')) as { n: number }).n;
    expect(profileCount).toBeGreaterThan(0);

    await applyDeclarativeConfig({
      customProviders: [{
        baseUrl: 'http://127.0.0.1:9124/v1',
        apiKey: 'local-key',
        label: 'Profile sync',
        models: [{ model: 'profile-sync-chat', displayName: 'Profile Sync Chat' }],
      }],
    });

    const model = (await db.get("SELECT id FROM models WHERE platform = 'custom' AND model_id = 'profile-sync-chat'")) as { id: number } | undefined;
    expect(model).toBeDefined();

    // Present in the chain...
    const inChain = (await db.get('SELECT 1 FROM fallback_config WHERE model_db_id = ?', [model!.id]));
    expect(inChain).toBeDefined();
    // ...and in every profile, which is what the router actually reads.
    expect(await profileRowCount(model!.id)).toBe(profileCount);
  });

  it('makes the model reachable through the active profile chain', async () => {
    const db = getDb();
    const profile = (await db.get('SELECT id FROM profiles ORDER BY id LIMIT 1')) as { id: number };
    (await db.run("INSERT INTO settings (key, value) VALUES ('active_profile_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(profile.id)]));

    await applyDeclarativeConfig({
      customProviders: [{
        baseUrl: 'http://127.0.0.1:9125/v1',
        apiKey: 'local-key',
        label: 'Reachable',
        models: [{ model: 'reachable-chat', displayName: 'Reachable Chat' }],
      }],
    });

    // resolveRoutingChain('auto') goes through the same active-profile lookup the
    // proxy uses, so this asserts real reachability rather than table contents.
    const { chain } = await resolveRoutingChain('auto');
    expect(chain.some(entry => entry.model_id === 'reachable-chat')).toBe(true);

    // The model must also be in the ACTIVE profile specifically, not just some profile.
    const model = (await db.get("SELECT id FROM models WHERE platform = 'custom' AND model_id = 'reachable-chat'")) as { id: number };
    const inActiveProfile = (await db.get('SELECT 1 FROM profile_models WHERE profile_id = ? AND model_db_id = ?', [profile.id, model.id]));
    expect(inActiveProfile).toBeDefined();

    (await db.run("DELETE FROM settings WHERE key = 'active_profile_id'"));
  });

  it('is idempotent — re-applying does not duplicate profile rows', async () => {
    const config = {
      customProviders: [{
        baseUrl: 'http://127.0.0.1:9126/v1',
        apiKey: 'local-key',
        label: 'Idempotent',
        models: [{ model: 'idempotent-chat', displayName: 'Idempotent Chat' }],
      }],
    };

    await applyDeclarativeConfig(config);
    await applyDeclarativeConfig(config);

    const model = (await getDb().get("SELECT id FROM models WHERE platform = 'custom' AND model_id = 'idempotent-chat'")) as { id: number };
    const profileCount = ((await getDb().get('SELECT COUNT(*) AS n FROM profiles')) as { n: number }).n;

    expect(await profileRowCount(model.id)).toBe(profileCount);
  });
});
