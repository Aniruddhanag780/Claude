import pg from 'pg';

export async function up(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    -- Search request log
    CREATE TABLE IF NOT EXISTS search_requests (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      engine_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      key_id INTEGER,
      status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
      latency_ms INTEGER NOT NULL DEFAULT 0,
      result_count INTEGER NOT NULL DEFAULT 0,
      client_agent TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_search_requests_created_at ON search_requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_search_requests_engine_created ON search_requests(engine_id, created_at);

    -- Optional group label for custom endpoints
    ALTER TABLE credentials ADD COLUMN IF NOT EXISTS group_label TEXT;

    -- Catalog model tombstones
    CREATE TABLE IF NOT EXISTS catalog_model_tombstones (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(kind, platform, model_id)
    );
  `);
}

export async function down(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    DROP INDEX IF EXISTS idx_search_requests_engine_created;
    DROP INDEX IF EXISTS idx_search_requests_created_at;
    DROP TABLE IF EXISTS search_requests;
    ALTER TABLE credentials DROP COLUMN IF EXISTS group_label;
  `);
}
