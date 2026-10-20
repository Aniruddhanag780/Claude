import type { Db } from '../types.js';

/** Guard so the migration can be re-run safely (roundtrip/catalog-sync tests re-run await up()). */
async function hasColumn(db: Db, table: string, column: string): Promise<boolean> {
  const columns = await db.all(`PRAGMA table_info(${table})`) as { name: string }[];
  return columns.some(col => col.name === column);
}

/**
 * Per-key monthly budget (#1158): optional request / token caps per api_keys
 * row, counted against the current UTC month's SUCCESSFUL requests. 0 means
 * "no cap" — the pre-existing behaviour, so existing installs are untouched.
 *
 * The columns live on api_keys (the operator-facing budget subject), matching
 * the per-key vocabulary already used for daily limits in ratelimit.ts; the
 * month is derived from requests.created_at (UTC), never wall-clock local.
 */
export async function up(db: Db): Promise<void> {
  if (!await hasColumn(db, 'api_keys', 'monthly_request_cap')) {
    await db.run('ALTER TABLE api_keys ADD COLUMN monthly_request_cap INTEGER NOT NULL DEFAULT 0');
  }
  if (!await hasColumn(db, 'api_keys', 'monthly_token_cap')) {
    await db.run('ALTER TABLE api_keys ADD COLUMN monthly_token_cap INTEGER NOT NULL DEFAULT 0');
  }
}

export async function down(db: Db): Promise<void> {
  for (const column of ['monthly_request_cap', 'monthly_token_cap']) {
    if (await hasColumn(db, 'api_keys', column)) {
      try {
        await db.run(`ALTER TABLE api_keys DROP COLUMN ${column}`);
      } catch {
        // best-effort: some builds pin the table; leaving the column harms nobody
      }
    }
  }
}
