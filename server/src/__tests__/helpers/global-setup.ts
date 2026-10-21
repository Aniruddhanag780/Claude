// Vitest global setup: reap scratch databases (`fm_test_*`) left behind by an
// interrupted earlier run. Runs before any test file; a no-op unless
// TEST_DATABASE_URL/DATABASE_URL is set.
import { Client } from 'pg';

export async function setup(): Promise<void> {
  const url = (process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '').trim();
  if (!url) return;
  const u = new URL(url);
  u.pathname = '/postgres';
  const c = new Client({ connectionString: u.toString() });
  await c.connect();
  try {
    const res = await c.query(`SELECT datname FROM pg_database WHERE datname LIKE 'fm_test_%'`);
    for (const row of res.rows as Array<{ datname: string }>) {
      await c.query(`DROP DATABASE IF EXISTS "${row.datname}"`).catch(() => {
        /* in use by a concurrent run — leave it */
      });
    }
  } finally {
    await c.end();
  }
}
