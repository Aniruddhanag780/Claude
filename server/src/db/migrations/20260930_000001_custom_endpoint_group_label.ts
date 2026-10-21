// Migration: optional group label for custom endpoints (#1176)
// Created: 2026-09-30
//
// DOWN: reversible
//
// All custom endpoints used to render under the single "Custom" group, which
// becomes unwieldy once more than a few relays are configured (#1176). An
// operator-set group label splits that group in the dashboard; NULL keeps the
// legacy single "Custom" group, so nothing changes until a label is set.
//
// Guarded like the baseline's column adds: catalog-sync re-runs migrations
// over a live schema, so ALTERs must be idempotent.

import type { Db } from '../types.js';

async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
  const columns = await db.all('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema AND table_name = ?', [table]) as { name: string }[];
  return columns.some(col => col.name === column);
}

export async function up(db: Db): Promise<void> {
  if (!await hasColumn(db, 'api_keys', 'group_label')) {
    await db.run('ALTER TABLE api_keys ADD COLUMN group_label TEXT');
  }
}

export async function down(db: Db): Promise<void> {
  if (await hasColumn(db, 'api_keys', 'group_label')) {
    await db.run('ALTER TABLE api_keys DROP COLUMN group_label');
  }
}
