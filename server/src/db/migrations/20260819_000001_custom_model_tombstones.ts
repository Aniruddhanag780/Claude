// Migration: keep user-deleted custom models deleted across the scheduled sync
// Created: 2026-08-19
//
// DOWN: reversible — the added table is dropped, which simply means deleted
// custom models can be re-added by the next sync pass again (#926).

import type { Db } from '../types.js';

export async function up(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS custom_model_tombstones (
      endpoint_scope TEXT NOT NULL,
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')),
      PRIMARY KEY (endpoint_scope, model_id)
    );
  `);
}

export async function down(db: Db): Promise<void> {
  await db.exec('DROP TABLE IF EXISTS custom_model_tombstones;');
}
