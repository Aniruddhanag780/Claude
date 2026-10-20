// Migration: caller dimension on request analytics
// Created: 2026-09-01
//
// DOWN: reversible
//
// Request log rows (requests table) gain a `caller` column so self-hosters can
// tell which pathway produced a request. Every inference surface writes 'http'
// today (see lib/request-log.ts for the full list and why /mcp and the
// dashboard write nothing); the column is free-form TEXT so a future surface
// can add a value without another migration. Pairs with the top-level
// `execution_id` on response bodies (see routes/proxy.ts) — given an id from a
// client error you can look up the row and see its caller at a glance.

import type { Db } from '../types.js';

async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
  const row = await db.all('SELECT column_name AS name FROM information_schema.columns WHERE table_name = ?', [table]) as Array<{ name: string }>;
  return row.some(c => c.name === column);
}

export async function up(db: Db): Promise<void> {
  if (!await hasColumn(db, 'requests', 'caller')) {
    await db.run('ALTER TABLE requests ADD COLUMN caller TEXT');
  }
}

export async function down(db: Db): Promise<void> {
  if (await hasColumn(db, 'requests', 'caller')) {
    await db.run('ALTER TABLE requests DROP COLUMN caller');
  }
}
