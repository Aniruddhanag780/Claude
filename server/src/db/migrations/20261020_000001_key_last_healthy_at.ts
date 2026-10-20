// Migration: last_healthy_at observability column on api_keys (#1493)
// Created: 2026-10-20
//
// DOWN: reversible (DROP COLUMN)
//
// A key can sit at status='healthy' with a fresh last_checked_at while never
// actually working: the transport-error path in services/health.ts refreshes
// last_checked_at but records no success, so "checked recently" is
// indistinguishable from "worked recently" (#1493). last_healthy_at is written
// only on evidence that the key WORKED — a valid probe verdict or a served
// live request — and never on a transport error, so "last worked N ago" is
// readable straight off the key row.
//
// Guarded like every other column add: catalog-sync re-runs migrations over a
// live schema, so ALTERs must be idempotent.

import type { Db } from '../types.js';

async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
  const columns = await db.all(`PRAGMA table_info(${table})`) as { name: string }[];
  return columns.some(col => col.name === column);
}

export async function up(db: Db): Promise<void> {
  if (!await hasColumn(db, 'api_keys', 'last_healthy_at')) {
    await db.run('ALTER TABLE api_keys ADD COLUMN last_healthy_at TEXT');
  }
}

export async function down(db: Db): Promise<void> {
  if (await hasColumn(db, 'api_keys', 'last_healthy_at')) {
    await db.run('ALTER TABLE api_keys DROP COLUMN last_healthy_at');
  }
}
