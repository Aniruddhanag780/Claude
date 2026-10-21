import { describe, expect, it } from 'vitest';
import type { Db } from '../../../db/types.js';
import { runMigrations } from '../../../db/migrate/runner.js';
import { up as runLegacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';
import {
  up as endpointIdentityUp,
  down as endpointIdentityDown,
} from '../../../db/migrations/20260729_000001_custom_model_endpoint_identity.js';
import { createEmptyTestDb } from '../../helpers/test-db.js';

// Per-endpoint model identity (#651): the migration has to change the shape of
// a table two other tables point INTO, on databases that are already carrying
// user data. These cases pin the two things that could quietly destroy an
// install: row ids drifting (which would silently re-point every fallback /
// profile / fusion reference at a different model) and the constraint change
// leaking into catalog platforms.
//
// PG: each test runs on an EMPTY scratch database seeded only with the legacy
// baseline, so the full migration chain exercises the same "existing install"
// path the SQLite version did.

async function addCustomKey(db: Db, baseUrl: string, label: string): Promise<number> {
  const r = await db.run(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', ?, 'enc', 'iv', 'tag', 'unknown', 1, ?)
    RETURNING id
  `, [label, baseUrl]);
  return Number(r.lastInsertRowid);
}

async function addCustomModel(db: Db, modelId: string, keyId: number): Promise<number> {
  const r = await db.run(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, key_id)
    VALUES ('custom', ?, ?, 50, 50, 1, ?)
    RETURNING id
  `, [modelId, modelId, keyId]);
  return Number(r.lastInsertRowid);
}

/** A DB seeded the way an existing install looks: custom models + chain refs. */
async function seededLegacyDb(): Promise<Db> {
  const { db, cleanup } = await createEmptyTestDb();
  // The suite drops the scratch DB via its own afterAll; these tests finish
  // long before global-setup reaping, and each test uses a fresh scratch DB.
  void cleanup;
  await runLegacyBaseline(db);

  const keyA = await addCustomKey(db, 'https://relay-a.example.com/v1', 'Relay A');
  const modelA = await addCustomModel(db, 'deepseek-v3.1', keyA);
  const legacy = await db.run(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
    VALUES ('custom', 'orphan-model', 'Orphan', 50, 50, 1)
    RETURNING id
  `);

  await db.run('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 900, 1)', [modelA]);
  await db.run('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 901, 1)', [Number(legacy.lastInsertRowid)]);

  const profile = await db.run("INSERT INTO profiles (name) VALUES ('Seeded') RETURNING id");
  await db.run('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)', [Number(profile.lastInsertRowid), modelA]);

  return db;
}

/** The PG equivalent of the old `db.pragma('foreign_key_check')`: no chain row may point at a missing model. */
async function orphanedChainRows(db: Db): Promise<number> {
  const fb = await db.get('SELECT COUNT(*) AS n FROM fallback_config f LEFT JOIN models m ON f.model_db_id = m.id WHERE m.id IS NULL') as { n: number };
  const pm = await db.get('SELECT COUNT(*) AS n FROM profile_models p LEFT JOIN models m ON p.model_db_id = m.id WHERE m.id IS NULL') as { n: number };
  return fb.n + pm.n;
}

/** Column snapshot — the PG equivalent of comparing `sqlite_master.sql`. */
async function modelsSchema(db: Db): Promise<unknown[]> {
  return db.all(`
    SELECT column_name, data_type, is_nullable, COALESCE(column_default, '') AS column_default
      FROM information_schema.columns
     WHERE table_name = 'models'
     ORDER BY ordinal_position
  `);
}

async function modelSeq(db: Db): Promise<number> {
  const row = await db.get("SELECT COALESCE(pg_sequence_last_value(pg_get_serial_sequence('models', 'id')), 0) AS seq") as { seq: number };
  return Number(row.seq);
}

async function modelColumns(db: Db): Promise<string[]> {
  return (await db.all(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'models' ORDER BY ordinal_position",
  ) as { column_name: string }[]).map(c => c.column_name);
}

describe('custom model endpoint identity migration', () => {
  it('keeps row ids and chain references intact on an existing DB', async () => {
    const db = await seededLegacyDb();

    const customBefore = await db.all("SELECT id, platform, model_id, key_id FROM models WHERE platform = 'custom' ORDER BY id");
    const seededIds = (customBefore as { id: number }[]).map(r => r.id);
    const chainOf = async () => await db.all(`SELECT model_db_id, priority, enabled FROM fallback_config
        WHERE model_db_id IN (${seededIds.join(',')}) ORDER BY model_db_id`);
    const seededProfileId = (await db.get("SELECT id FROM profiles WHERE name = 'Seeded'") as { id: number }).id;
    const seededModelId = seededIds[0];
    const profileOf = async () => await db.all('SELECT profile_id, model_db_id, priority, enabled FROM profile_models WHERE profile_id = ? AND model_db_id = ?', [seededProfileId, seededModelId]);
    const fallbackBefore = await chainOf();
    const profileBefore = await profileOf();
    const countModels = async () => (await db.get("SELECT COUNT(*) AS n FROM models WHERE platform != 'github'") as { n: number }).n;
    const totalBefore = await countModels();

    await runMigrations(db, 'up');

    // Ids are the load-bearing part: fallback_config / profile_models / saved
    // fusion configs all address models BY id, so a rebuild that renumbered
    // would silently re-point them at unrelated models.
    expect(await db.all("SELECT id, platform, model_id, key_id FROM models WHERE platform = 'custom' ORDER BY id")).toEqual(customBefore);
    expect(await chainOf()).toEqual(fallbackBefore);
    expect(await profileOf()).toEqual(profileBefore);
    expect(await orphanedChainRows(db)).toBe(0);
    // Nothing was dropped on the way through: later migrations only add rows,
    // apart from the retired GitHub provider's (#1557).
    expect(await countModels()).toBeGreaterThanOrEqual(totalBefore);
  });

  it('backfills the endpoint scope from each custom model\'s bound key', async () => {
    const db = await seededLegacyDb();
    await runMigrations(db, 'up');

    const scopes = await db.all('SELECT model_id, endpoint_scope FROM models ORDER BY model_id') as { model_id: string; endpoint_scope: string }[];
    const byId = new Map(scopes.map(s => [s.model_id, s.endpoint_scope]));

    expect(byId.get('deepseek-v3.1')).toBe('https://relay-a.example.com/v1');
    // No bound key → no scope, so a legacy row keeps the identity it had.
    expect(byId.get('orphan-model')).toBe('');
    // Catalog rows are never endpoint-scoped.
    const catalogScoped = await db.get("SELECT COUNT(*) AS n FROM models WHERE platform != 'custom' AND endpoint_scope <> ''") as { n: number };
    expect(catalogScoped.n).toBe(0);
  });

  it('lets two endpoints hold the same model id, but still rejects catalog duplicates', async () => {
    const db = await seededLegacyDb();
    await runMigrations(db, 'up');

    const keyB = await addCustomKey(db, 'https://relay-b.example.com/v1', 'Relay B');
    await db.run(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, key_id, source, endpoint_scope)
      VALUES ('custom', 'deepseek-v3.1', 'deepseek-v3.1', 50, 50, 1, ?, 'user', 'https://relay-b.example.com/v1')
    `, [keyB]);

    const rows = await db.all("SELECT endpoint_scope FROM models WHERE model_id = 'deepseek-v3.1' ORDER BY id") as { endpoint_scope: string }[];
    expect(rows.map(r => r.endpoint_scope)).toEqual([
      'https://relay-a.example.com/v1',
      'https://relay-b.example.com/v1',
    ]);

    // Same endpoint, same model id → still one row.
    await expect(db.run(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source, endpoint_scope)
      VALUES ('custom', 'deepseek-v3.1', 'dupe', 50, 50, 1, 'user', 'https://relay-b.example.com/v1')
    `)).rejects.toThrow(/UNIQUE/i);

    // Catalog platforms keep exactly the old (platform, model_id) rule.
    const anyCatalog = await db.get("SELECT platform, model_id FROM models WHERE platform != 'custom' LIMIT 1") as { platform: string; model_id: string };
    await expect(db.run(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
      VALUES (?, ?, 'dupe', 50, 50, 1)
    `, [anyCatalog.platform, anyCatalog.model_id])).rejects.toThrow(/UNIQUE/i);
  });

  it('keeps the identity high-water mark so deleted ids are never reused', async () => {
    const db = await seededLegacyDb();
    await runMigrations(db, 'up');

    // Catalog sync prunes models routinely, so the highest ids are often gone
    // while the counter still remembers them. A rebuild that lets the counter
    // fall back to MAX(id) would re-issue those ids, and a stale
    // fallback_config / profile_models row would silently adopt a new model.
    const top = (await db.get('SELECT MAX(id) AS m FROM models') as { m: number }).m;
    await db.run('DELETE FROM profile_models WHERE model_db_id > ?', [top - 3]);
    await db.run('DELETE FROM fallback_config WHERE model_db_id > ?', [top - 3]);
    await db.run('DELETE FROM models WHERE id > ?', [top - 3]);
    const seqBefore = await modelSeq(db);
    expect(seqBefore).toBeGreaterThan(
      (await db.get('SELECT MAX(id) AS m FROM models') as { m: number }).m as number,
    );

    // Exercise the rebuild itself, with no other migration able to nudge the
    // counter back up.
    await endpointIdentityDown(db);
    await endpointIdentityUp(db);

    expect(await modelSeq(db)).toBe(seqBefore);
    const inserted = await db.get(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
      VALUES ('custom', 'fresh-model', 'Fresh', 50, 50, 1) RETURNING id
    `) as { id: number };
    expect(inserted.id).toBeGreaterThan(seqBefore - 1);
    expect(inserted.id).toBeGreaterThan(top);
  });

  it('is idempotent across a down/up round trip and refuses to drop duplicates', async () => {
    const db = await seededLegacyDb();
    await runMigrations(db, 'up');
    const afterFirstUp = await db.all('SELECT * FROM models ORDER BY id');
    const schemaAfterFirstUp = await modelsSchema(db);

    await endpointIdentityDown(db);
    expect(await modelColumns(db)).not.toContain('endpoint_scope');

    await endpointIdentityUp(db);
    expect(await db.all('SELECT * FROM models ORDER BY id')).toEqual(afterFirstUp);
    expect(await modelsSchema(db)).toEqual(schemaAfterFirstUp);
    expect(await orphanedChainRows(db)).toBe(0);

    // With a real duplicate on the books, down() has no honest answer.
    const keyB = await addCustomKey(db, 'https://relay-b.example.com/v1', 'Relay B');
    await db.run(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, key_id, source, endpoint_scope)
      VALUES ('custom', 'deepseek-v3.1', 'deepseek-v3.1', 50, 50, 1, ?, 'user', 'https://relay-b.example.com/v1')
    `, [keyB]);
    await expect(endpointIdentityDown(db)).rejects.toThrow(/more than one endpoint/);
  });
});
