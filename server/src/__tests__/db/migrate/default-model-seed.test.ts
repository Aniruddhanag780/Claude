import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { up as runLegacyBaseline } from '../../../db/migrations/20260101_000000_legacy_baseline.js';

// The default catalog — the models every install starts with, and the chain
// that serves them — is seeded by the legacy baseline.
//
// `models` is unique on (platform, model_id). A database that already carries
// a model's new id (the catalog syncs it, the seed inserts it) while the old
// id is still there from an earlier release used to abort the boot with
// "UNIQUE constraint failed: models.platform, models.model_id" when the
// baseline renamed the old id onto it (#1603).

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function seededDb(): Database.Database {
  const db = new Database(':memory:');
  dbs.push(db);
  runLegacyBaseline(db);
  return db;
}

function modelIds(db: Database.Database, platform: string): string[] {
  return (db
    .prepare('SELECT model_id FROM models WHERE platform = ? ORDER BY model_id')
    .all(platform) as { model_id: string }[]
  ).map((row) => row.model_id);
}

function duplicatePairs(db: Database.Database): unknown[] {
  return db
    .prepare(`
      SELECT platform, model_id, COUNT(*) AS n
        FROM models
       GROUP BY platform, model_id
      HAVING n > 1
    `)
    .all();
}

describe('the default model seed', () => {
  it('seeds the default catalog on a database that already has rows', () => {
    const db = seededDb();

    // A database that does not carry every default model: the seed is
    // idempotent, so the model is there again and nothing is duplicated.
    db.prepare(`
      DELETE FROM fallback_config
       WHERE model_db_id = (SELECT id FROM models WHERE platform = 'google' AND model_id = 'gemini-2.5-flash')
    `).run();
    db.prepare("DELETE FROM models WHERE platform = 'google' AND model_id = 'gemini-2.5-flash'").run();
    expect(modelIds(db, 'google')).not.toContain('gemini-2.5-flash');

    runLegacyBaseline(db);

    expect(modelIds(db, 'google')).toContain('gemini-2.5-flash');
    expect(duplicatePairs(db)).toEqual([]);
  });

  it('does not abort the boot when a model id is renamed onto an id that is already there', () => {
    const db = seededDb();

    // The state an upgraded database is in: the old id is still there from an
    // earlier release, and the new id is already there too.
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank)
      VALUES ('openrouter', 'deepseek/deepseek-r1:free', 'DeepSeek R1 (free)', 2, 10)
    `).run();
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank)
      VALUES ('openrouter', 'deepseek/deepseek-v3.1:free', 'DeepSeek V3.1 (free)', 2, 10)
    `).run();

    // The rename cannot land on an id another row holds, and the boot must
    // not die with it.
    expect(() => runLegacyBaseline(db)).not.toThrow();
    expect(duplicatePairs(db)).toEqual([]);
    // The row that still carries the old id is the stale one: the id is gone
    // upstream, so it goes the way the retired models go.
    expect(modelIds(db, 'openrouter')).not.toContain('deepseek/deepseek-r1:free');
  });

  it('keeps (platform, model_id) unique', () => {
    const db = seededDb();

    // The constraint is what makes the seed idempotent, so it stays: the fix
    // does not weaken the schema.
    expect(() => {
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank)
        VALUES ('google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 4, 5)
      `).run();
    }).toThrow(/UNIQUE constraint failed/);
  });
});
