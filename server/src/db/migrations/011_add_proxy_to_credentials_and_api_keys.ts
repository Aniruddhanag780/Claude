import pg from 'pg';

export async function up(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    ALTER TABLE credentials
    ADD COLUMN IF NOT EXISTS proxy_encrypted TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS proxy_iv VARCHAR(64) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS proxy_auth_tag VARCHAR(64) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS base_url TEXT DEFAULT NULL;
  `);

  await client.query(`
    ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS proxy_encrypted TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS proxy_iv TEXT DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS proxy_auth_tag TEXT DEFAULT NULL;
  `);
}

export async function down(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    ALTER TABLE credentials
    DROP COLUMN IF EXISTS proxy_encrypted,
    DROP COLUMN IF EXISTS proxy_iv,
    DROP COLUMN IF EXISTS proxy_auth_tag,
    DROP COLUMN IF EXISTS base_url;
  `);

  await client.query(`
    ALTER TABLE api_keys
    DROP COLUMN IF EXISTS proxy_encrypted,
    DROP COLUMN IF EXISTS proxy_iv,
    DROP COLUMN IF EXISTS proxy_auth_tag;
  `);
}
