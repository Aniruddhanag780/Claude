import { describe, expect, it } from 'vitest';
import type { Db } from '../../../db/types.js';
import { up as runLegacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';
import { down, up } from '../../../db/migrations/20260726_000003_model_source_provenance.js';
import { createEmptyTestDb } from '../../helpers/test-db.js';

// The models.source backfill decides which pre-existing rows catalog-sync is
// allowed to prune. Getting it wrong in the 'catalog' direction deletes
// user-added models on the next sync, so these tests pin the heuristic:
//  - custom platform / key-bound / 'User'/'Custom'-labelled rows -> 'user'
//  - rows the applied catalog (settings.catalog_applied_json) lists -> 'catalog'
//  - rows it does NOT list -> 'user' (sync would have pruned catalog leftovers)
//  - no applied catalog at all -> remaining rows are baseline seeds -> 'catalog'
//
// PG: each test gets an EMPTY scratch database seeded only with the legacy
// baseline (the old `new Database(':memory:')` equivalent).

async function seededDb(): Promise<Db> {
  const { db } = await createEmptyTestDb();
  await runLegacyBaseline(db);
  return db;
}

async function insertModel(
  db: Db,
  platform: string,
  modelId: string,
  over: { keyId?: number | null; sizeLabel?: string } = {},
): Promise<void> {
  await db.run(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, key_id, enabled)
    VALUES (?, ?, ?, 50, 50, ?, ?, 1)
  `, [platform, modelId, modelId, over.sizeLabel ?? 'Large', over.keyId ?? null]);
}

async function sourceOf(db: Db, platform: string, modelId: string): Promise<string> {
  const row = await db.get('SELECT source FROM models WHERE platform = ? AND model_id = ?', [platform, modelId]) as { source: string };
  return row.source;
}

async function setAppliedCatalog(db: Db, value: string): Promise<void> {
  await db.run("INSERT INTO settings (key, value) VALUES ('catalog_applied_json', ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [value]);
}

describe('20260726_000003_model_source_provenance backfill', () => {
  it('marks custom-platform, key-bound and User/Custom-labelled rows as user', async () => {
    const db = await seededDb();

    await insertModel(db, 'custom', 'my-endpoint-model', { sizeLabel: 'Custom' });
    await insertModel(db, 'groq', 'key-bound-model', { keyId: 42 });
    await insertModel(db, 'groq', 'declarative-default-label', { sizeLabel: 'User' });

    await up(db);

    expect(await sourceOf(db, 'custom', 'my-endpoint-model')).toBe('user');
    expect(await sourceOf(db, 'groq', 'key-bound-model')).toBe('user');
    expect(await sourceOf(db, 'groq', 'declarative-default-label')).toBe('user');
  });

  it('keeps baseline seeds as catalog when no catalog was ever applied', async () => {
    const db = await seededDb();

    await up(db);
    const counts = await db.get(`
      SELECT SUM(CASE WHEN source = 'user' THEN 1 ELSE 0 END) AS user_rows,
             SUM(CASE WHEN source = 'catalog' THEN 1 ELSE 0 END) AS catalog_rows
        FROM models
    `) as { user_rows: number | null; catalog_rows: number };
    // A fresh install has only bundled-baseline rows: all catalog-owned.
    expect(counts.user_rows ?? 0).toBe(0);
    expect(counts.catalog_rows).toBeGreaterThan(0);
  });

  it('marks rows absent from the applied catalog as user, listed rows as catalog', async () => {
    const db = await seededDb();

    // Hand-added native-platform model whose size_label does NOT follow the
    // 'User'/'Custom' convention — exactly the row the old prune guard lost.
    await insertModel(db, 'groq', 'hand-added-model', { sizeLabel: 'Large' });

    // Applied catalog = every baseline row except the hand-added one.
    const models = await db.all("SELECT platform, model_id FROM models WHERE model_id != 'hand-added-model'") as { platform: string; model_id: string }[];
    await setAppliedCatalog(db, JSON.stringify({
      version: '2099.01.01',
      tier: 'live',
      models: models.map((m) => ({ platform: m.platform, modelId: m.model_id })),
      quirks: [],
    }));

    await up(db);

    expect(await sourceOf(db, 'groq', 'hand-added-model')).toBe('user');
    const listed = models[0]!;
    expect(await sourceOf(db, listed.platform, listed.model_id)).toBe('catalog');
  });

  it('survives a corrupt cached catalog and still applies the heuristics', async () => {
    const db = await seededDb();

    await insertModel(db, 'custom', 'corrupt-cache-model', { sizeLabel: 'Custom' });
    await setAppliedCatalog(db, 'not json {');

    await expect(up(db)).resolves.not.toThrow();
    expect(await sourceOf(db, 'custom', 'corrupt-cache-model')).toBe('user');
  });

  it('down drops the column and up is re-runnable', async () => {
    const db = await seededDb();

    await up(db);
    await down(db);
    const columns = await db.all(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'models'",
    ) as { column_name: string }[];
    expect(columns.some((c) => c.column_name === 'source')).toBe(false);
    await expect(up(db)).resolves.not.toThrow();
    await expect(up(db)).resolves.not.toThrow();
  });
});
