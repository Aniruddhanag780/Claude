// Migration: tag provider-moment failures on requests (#1347 PR 1)
// Created: 2026-10-17
//
// DOWN: reversible (DROP COLUMN)

import type { Db } from '../types.js';

async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
  const columns = await db.all('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema AND table_name = ?', [table]) as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

// #1347 (PR 1): rate-limit-aware failure attribution. A failed attempt whose
// root cause is a provider moment — a 429, a 5xx, a timeout, a dropped socket
// — is evidence about the provider's minute, not the model's quality. When
// the opt-in setting is on, such rows are tagged 'provider_moment' so the
// routing stats can exclude them from the model-level books. NULL (the
// default, and every historical row) means "unattributed" and keeps today's
// scoring behaviour exactly.
export async function up(db: Db): Promise<void> {
  if (!await hasColumn(db, 'requests', 'failure_attribution')) {
    await db.run('ALTER TABLE requests ADD COLUMN failure_attribution TEXT');
  }
}

export async function down(db: Db): Promise<void> {
  if (await hasColumn(db, 'requests', 'failure_attribution')) {
    await db.run('ALTER TABLE requests DROP COLUMN failure_attribution');
  }
}
