import type { Db } from '../types.js';

const DOWNGRADE_MARKER_KEY = 'profile_chain_backfill_downgraded';

/**
 * The router prefers the active profile's `profile_models` chain, while the
 * visible Models page historically edited `fallback_config`. New rows added by
 * catalog sync or custom providers were therefore missing from the hidden active
 * profile and never entered auto routing. Backfill every profile with any model
 * rows it lacks, preserving the current fallback_config enabled flag for the
 * initial auto-routing state.
 */
export async function up(db: Db): Promise<void> {
  await db.run('DELETE FROM settings WHERE key = ?', [DOWNGRADE_MARKER_KEY]);

  const profiles = await db.all('SELECT id FROM profiles ORDER BY id ASC') as { id: number }[];
  if (profiles.length === 0) return;

  const missing = `
    SELECT m.id, f.enabled
      FROM fallback_config f
      JOIN models m ON m.id = f.model_db_id
      LEFT JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id
     WHERE pm.id IS NULL
     ORDER BY f.priority, m.id
  `;
  const maxPriority = 'SELECT COALESCE(MAX(priority), 0) AS max_priority FROM profile_models WHERE profile_id = ?';
  const insert = 'INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)';

  for (const profile of profiles) {
    const rows = await db.all(missing, [profile.id]) as { id: number; enabled: number }[];
    if (rows.length === 0) continue;
    const max = await db.get(maxPriority, [profile.id]) as { max_priority: number };
    for (const [index, row] of rows.entries()) {
      await db.run(insert, [profile.id, row.id, max.max_priority + index + 1, row.enabled]);
    }
  }
}

export async function down(db: Db): Promise<void> {
  // Removing rows on downgrade would discard user-managed profile order and
  // enabled state. Older app versions ignore this marker, and the next upgrade
  // removes it before re-running the backfill.
  await db.run(`
    INSERT INTO settings (key, value)
    VALUES (?, to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `, [DOWNGRADE_MARKER_KEY]);
}
