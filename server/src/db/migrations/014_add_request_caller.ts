import pg from 'pg';

// The `caller` dimension (#1102) tells a self-hoster which gateway pathway
// produced a request ('http' | 'mcp' | 'web'). The fork's SQLite→PostgreSQL
// port recreated `requests` in 008 without it and kept writing the value into
// `client_agent` (the agent classifier's column), so the dimension was lost.
//
// SQLite-era `CREATE TABLE` was idempotent; in PostgreSQL a column can only
// be added once, so this is a forward migration. Existing rows stay NULL,
// which is exactly what the reader expects for a request logged before the
// column existed.
export async function up(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    ALTER TABLE requests
    ADD COLUMN IF NOT EXISTS caller TEXT
  `);
}

export async function down(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    ALTER TABLE requests
    DROP COLUMN IF EXISTS caller
  `);
}
