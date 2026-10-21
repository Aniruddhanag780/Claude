import type { Db } from '../types.js';

async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
  const columns = await db.all('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema AND table_name = ?', [table]) as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

/** Per-chain opt-out from the catalog-sync backfill (#895).
 *
 *  Every profile used to be a copy of the whole catalog, and `ensureAllModelsInProfiles`
 *  put each newly synced model into every profile. That is right for a chain
 *  the user never pruned, and wrong for one they curated by hand: the next
 *  catalog sync silently pushed a dozen models back into it.
 *
 *  1 (the default, and what every existing chain gets) keeps the old behaviour.
 *  A chain created with `empty: true` starts at 0, so it only ever holds what
 *  the user put in it. */
export async function up(db: Db): Promise<void> {
  if (!await hasColumn(db, 'profiles', 'auto_include_new_models')) {
    await db.run('ALTER TABLE profiles ADD COLUMN auto_include_new_models BIGINT NOT NULL DEFAULT 1');
  }
}

export async function down(db: Db): Promise<void> {
  if (await hasColumn(db, 'profiles', 'auto_include_new_models')) {
    await db.run('ALTER TABLE profiles DROP COLUMN auto_include_new_models');
  }
}
