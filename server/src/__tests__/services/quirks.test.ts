import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from '../../db/index.js';
import { resolveQuirksByModel, quirkKey, listQuirkDefinitions } from '../../services/quirks.js';
import { initTestDb } from '../helpers/test-db.js';

// The quirks layer is the catalog product's data integrity: one quirk is
// applied to many models by selector parameters (migrateQuirksV1). These lock
// the platform / glob / global selectors and the resolver that the catalog
// export depends on.
describe('quirks resolution (migrateQuirksV1)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  async function slugsFor(platform: string, modelId: string): string[] {
    return ((await resolveQuirksByModel()).get(quirkKey(platform, modelId)) ?? []).map((q) => q.slug);
  }

  it('applies a platform-level quirk to every model on that platform', async () => {
    const nvidiaModels = (await getDb().all("SELECT model_id FROM models WHERE platform = 'nvidia'")) as { model_id: string }[];
    expect(nvidiaModels.length).toBeGreaterThan(0);
    for (const m of nvidiaModels) {
      expect(await slugsFor('nvidia', m.model_id)).toContain('nvidia-rate-limited');
    }
  });

  it('applies a glob quirk only to matching model ids', async () => {
    // or-ultra-hangs targets openrouter '*nemotron-3-ultra*'
    const ultra = (await getDb().get("SELECT model_id FROM models WHERE platform = 'openrouter' AND model_id GLOB '*nemotron-3-ultra*'")) as { model_id: string } | undefined;
    if (ultra) expect(await slugsFor('openrouter', ultra.model_id)).toContain('or-ultra-hangs');

    // A non-matching openrouter model must NOT pick it up.
    const other = (await getDb().get("SELECT model_id FROM models WHERE platform = 'openrouter' AND model_id NOT GLOB '*nemotron-3-ultra*'")) as { model_id: string } | undefined;
    if (other) expect(await slugsFor('openrouter', other.model_id)).not.toContain('or-ultra-hangs');
  });

  it('does not leak a platform quirk onto other platforms', async () => {
    const google = (await getDb().get("SELECT model_id FROM models WHERE platform = 'google'")) as { model_id: string } | undefined;
    if (google) expect(await slugsFor('google', google.model_id)).not.toContain('cloudflare-key-format');
  });

  it('lists quirk definitions with their selector parameters', async () => {
    const defs = await listQuirkDefinitions();
    const keyless = defs.find((d) => d.slug === 'keyless-anonymous');
    expect(keyless).toBeDefined();
    // Pollinations chat now requires a publishable key; three anonymous
    // providers remain in the baseline selector.
    const platforms = keyless!.targets.map((t) => t.platform).sort();
    expect(platforms).toEqual(['kilo', 'llm7', 'ovh']);
  });

  it('resolves stably and dedups overlapping selectors', async () => {
    // A model matched by two of a quirk's selectors must list it once (DISTINCT).
    const a = await resolveQuirksByModel();
    const b = await resolveQuirksByModel();
    expect(a.size).toBe(b.size);
    for (const [key, quirks] of a) {
      const slugs = quirks.map((q) => q.slug);
      expect(new Set(slugs).size).toBe(slugs.length); // no duplicates
      expect(b.get(key)!.map((q) => q.slug)).toEqual(slugs); // stable
    }
  });
});
