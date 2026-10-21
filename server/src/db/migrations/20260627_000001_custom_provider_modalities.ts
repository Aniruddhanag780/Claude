import type { Db } from '../types.js';

async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
  const columns = await db.all('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema AND table_name = ?', [table]) as { name: string }[];
  return columns.some(col => col.name === column);
}

async function addKeyIdColumn(db: Db, table: string): Promise<void> {
  if (!await hasColumn(db, table, 'key_id')) {
    await db.run(`ALTER TABLE ${table} ADD COLUMN key_id BIGINT`);
  }
}

async function dropKeyIdColumn(db: Db, table: string): Promise<void> {
  if (await hasColumn(db, table, 'key_id')) {
    await db.run(`ALTER TABLE ${table} DROP COLUMN key_id`);
  }
}

export async function up(db: Db): Promise<void> {
  await addKeyIdColumn(db, 'embedding_models');
  await addKeyIdColumn(db, 'media_models');
  await db.run('CREATE INDEX IF NOT EXISTS idx_embedding_models_key_id ON embedding_models(key_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_media_models_key_id ON media_models(key_id)');
}

export async function down(db: Db): Promise<void> {
  await db.run('DROP INDEX IF EXISTS idx_embedding_models_key_id');
  await db.run('DROP INDEX IF EXISTS idx_media_models_key_id');
  await dropKeyIdColumn(db, 'media_models');
  await dropKeyIdColumn(db, 'embedding_models');
}
