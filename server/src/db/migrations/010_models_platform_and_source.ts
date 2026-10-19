import pg from 'pg';

export async function up(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    ALTER TABLE models
    ADD COLUMN IF NOT EXISTS platform VARCHAR(64),
    ADD COLUMN IF NOT EXISTS source VARCHAR(32) NOT NULL DEFAULT 'catalog';
  `);

  // Backfill platform from providers
  const providers = await client.query('SELECT id, provider_key FROM providers');
  for (const p of providers.rows) {
    await client.query('UPDATE models SET platform = $1 WHERE provider_id = $2', [p.provider_key, p.id]);
  }
  await client.query("UPDATE models SET source = 'catalog' WHERE source IS NULL");

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_models_platform ON models(platform);
    CREATE INDEX IF NOT EXISTS idx_models_source ON models(source);
  `);
}

export async function down(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    ALTER TABLE models
    DROP COLUMN IF EXISTS platform,
    DROP COLUMN IF EXISTS source;
  `);
}
