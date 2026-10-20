import type { Db } from '../types.js';

async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
  const columns = await db.all(`PRAGMA table_info(${table})`) as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

/** Persist the most recent failed health-probe reason for local diagnostics. */
export async function up(db: Db): Promise<void> {
  if (!await hasColumn(db, 'api_keys', 'last_health_error')) {
    await db.run('ALTER TABLE api_keys ADD COLUMN last_health_error TEXT');
  }
}

export async function down(db: Db): Promise<void> {
  if (await hasColumn(db, 'api_keys', 'last_health_error')) {
    await db.run('ALTER TABLE api_keys DROP COLUMN last_health_error');
  }
}
