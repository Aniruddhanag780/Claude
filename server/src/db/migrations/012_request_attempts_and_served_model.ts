import pg from 'pg';

export async function up(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    ALTER TABLE requests
    ADD COLUMN IF NOT EXISTS served_model TEXT DEFAULT NULL;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS request_attempts (
      id SERIAL PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_ordinal INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      start_offset_ms INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error_summary TEXT DEFAULT NULL,
      key_label TEXT DEFAULT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_request_attempts_request_id
      ON request_attempts(request_id, ordinal);
  `);
}

export async function down(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    DROP INDEX IF EXISTS idx_request_attempts_request_id;
    DROP TABLE IF EXISTS request_attempts;
  `);

  await client.query(`
    ALTER TABLE requests
    DROP COLUMN IF EXISTS served_model;
  `);
}
