import type { Db } from '../types.js';

async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
  const columns = await db.all('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema AND table_name = ?', [table]) as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

/** Optional per-key model scope (#657): a JSON array of model_id strings the
 *  key may serve. NULL = the key serves every model of its platform. */
export async function up(db: Db): Promise<void> {
  if (!await hasColumn(db, 'api_keys', 'model_scope_json')) {
    await db.run('ALTER TABLE api_keys ADD COLUMN model_scope_json TEXT');
  }
}

export async function down(db: Db): Promise<void> {
  if (await hasColumn(db, 'api_keys', 'model_scope_json')) {
    await db.run('ALTER TABLE api_keys DROP COLUMN model_scope_json');
  }
}
