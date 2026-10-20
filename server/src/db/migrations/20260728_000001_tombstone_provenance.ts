// Migration: record WHY a catalog model was tombstoned
// Created: 2026-07-28
//
// DOWN: reversible — drops the two added columns (every existing tombstone is
// a user deletion, which is the default the columns backfill to).

import type { Db } from '../types.js';

async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
  const columns = await db.all(`PRAGMA table_info(${table})`) as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

/**
 * Tombstones used to mean exactly one thing: "the user deleted this catalog
 * model, keep it deleted across syncs". Issue #634 adds a second, machine-made
 * kind — "the provider retired this model upstream (410 / end of life)" — which
 * disables the row instead of deleting it and carries the upstream wording so
 * the dashboard can say why. `source` keeps the two apart ('user' is the
 * backfill for every pre-existing row); `reason` is the redacted provider text.
 */
export async function up(db: Db): Promise<void> {
  if (!await hasColumn(db, 'catalog_model_tombstones', 'source')) {
    await db.run("ALTER TABLE catalog_model_tombstones ADD COLUMN source TEXT NOT NULL DEFAULT 'user'");
  }
  if (!await hasColumn(db, 'catalog_model_tombstones', 'reason')) {
    await db.run('ALTER TABLE catalog_model_tombstones ADD COLUMN reason TEXT');
  }
}

export async function down(db: Db): Promise<void> {
  // Upstream-retirement tombstones have no meaning without their source column,
  // and leaving them behind would silently delete live models on the next sync.
  await db.run("DELETE FROM catalog_model_tombstones WHERE source = 'upstream_eol'");
  if (await hasColumn(db, 'catalog_model_tombstones', 'reason')) {
    await db.run('ALTER TABLE catalog_model_tombstones DROP COLUMN reason');
  }
  if (await hasColumn(db, 'catalog_model_tombstones', 'source')) {
    await db.run('ALTER TABLE catalog_model_tombstones DROP COLUMN source');
  }
}
