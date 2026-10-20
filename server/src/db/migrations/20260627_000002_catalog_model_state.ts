import type { Db } from '../types.js';

export async function up(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_model_tombstones (
      kind TEXT NOT NULL DEFAULT 'chat',
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')),
      PRIMARY KEY (kind, platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS model_overrides (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      overrides_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')),
      PRIMARY KEY (platform, model_id)
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_model_tombstones_platform_model
      ON catalog_model_tombstones(platform, model_id);
  `);
}

export async function down(db: Db): Promise<void> {
  await db.exec(`
    DROP INDEX IF EXISTS idx_catalog_model_tombstones_platform_model;
    DROP TABLE IF EXISTS model_overrides;
    DROP TABLE IF EXISTS catalog_model_tombstones;
  `);
}
