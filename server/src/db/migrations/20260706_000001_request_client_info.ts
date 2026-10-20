import type { Db } from '../types.js';

/**
 * Record WHO made each proxied call. All local clients share the single
 * unified API key, so the key can't distinguish callers — the client IP
 * (plus User-Agent for tunneled clients that all arrive as loopback) is the
 * only per-caller signal available to the analytics "Recent calls" view.
 *
 * Guarded like the baseline's column adds: catalog-sync re-runs migrations
 * over a live schema, so ALTERs must be idempotent.
 */
async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
  const columns = await db.all(`PRAGMA table_info(${table})`) as { name: string }[];
  return columns.some(col => col.name === column);
}

export async function up(db: Db): Promise<void> {
  if (!await hasColumn(db, 'requests', 'client_ip')) {
    await db.run('ALTER TABLE requests ADD COLUMN client_ip TEXT');
  }
  if (!await hasColumn(db, 'requests', 'client_user_agent')) {
    await db.run('ALTER TABLE requests ADD COLUMN client_user_agent TEXT');
  }
}

export async function down(db: Db): Promise<void> {
  if (await hasColumn(db, 'requests', 'client_user_agent')) {
    await db.run('ALTER TABLE requests DROP COLUMN client_user_agent');
  }
  if (await hasColumn(db, 'requests', 'client_ip')) {
    await db.run('ALTER TABLE requests DROP COLUMN client_ip');
  }
}
