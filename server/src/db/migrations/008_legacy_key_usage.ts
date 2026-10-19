import pg from 'pg';

// Recreates the SQLite-era tables that still have live production readers the
// registry does not cover (router.ts, provider-credential.ts, custom-endpoint
// creation, declarative-config, health probes, embeddings/media/moderation
// logging, rate limiting, retention) plus the monthly ledger (#1158). At HEAD
// these tables had no PostgreSQL home at all, so on a real database every one
// of those paths failed — the silent-fake era mocked them; the fail-loud shims
// now surface it. The SQLite→Postgres migration script seeds api_keys,
// requests, key_monthly_usage and request_hourly from the legacy database.
export async function up(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    -- Per-credential monthly caps (#1158). The registry serves rows from
    -- credentials, so caps and the ledger are keyed by credential id.
    ALTER TABLE credentials ADD COLUMN IF NOT EXISTS monthly_request_cap INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE credentials ADD COLUMN IF NOT EXISTS monthly_token_cap INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS key_monthly_usage (
      key_id INTEGER NOT NULL,
      month TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (key_id, month)
    );
    CREATE INDEX IF NOT EXISTS idx_key_monthly_usage_month ON key_monthly_usage(month);

    -- Legacy key surface: router fallback paths, declarative config, custom
    -- endpoints, provider-credential reservation and health probes all read or
    -- write these rows. Key ids are preserved by the migration script so the
    -- ledger keeps matching exactly the keys it metered in SQLite.
    CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      base_url TEXT,
      group_label TEXT,
      status TEXT NOT NULL DEFAULT 'unknown',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_checked_at TEXT,
      last_health_error TEXT,
      created_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform, enabled);

    -- Raw request log (embeddings/media/moderation insert; retention prunes).
    CREATE TABLE IF NOT EXISTS requests (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      request_type TEXT,
      client_ip TEXT,
      client_user_agent TEXT,
      client_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
    );
    CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);

    CREATE OR REPLACE FUNCTION update_key_monthly_usage()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.key_id IS NOT NULL AND NEW.status = 'success' THEN
        INSERT INTO key_monthly_usage (key_id, month, requests, tokens)
        VALUES (NEW.key_id, to_char(COALESCE(NULLIF(NEW.created_at, '')::timestamp, NOW()), 'YYYY-MM'), 1,
                GREATEST(0, COALESCE(NEW.input_tokens, 0)) + GREATEST(0, COALESCE(NEW.output_tokens, 0)))
        ON CONFLICT (key_id, month) DO UPDATE SET
          requests = key_monthly_usage.requests + 1,
          tokens = key_monthly_usage.tokens + EXCLUDED.tokens;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS requests_key_monthly_usage ON requests;
    CREATE TRIGGER requests_key_monthly_usage
    AFTER INSERT ON requests
    FOR EACH ROW
    EXECUTE FUNCTION update_key_monthly_usage();

    -- In-memory limiter's durable usage + cooldown tables (ratelimit.ts).
    CREATE TABLE IF NOT EXISTS rate_limit_usage (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('request', 'tokens')),
      tokens INTEGER NOT NULL DEFAULT 0,
      created_at_ms BIGINT NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limit_usage_lookup
      ON rate_limit_usage(platform, model_id, key_id, kind, created_at_ms);

    CREATE TABLE IF NOT EXISTS rate_limit_cooldowns (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      expires_at_ms BIGINT NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'heuristic',
      set_at_ms BIGINT,
      created_at TEXT NOT NULL DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
      PRIMARY KEY (platform, model_id, key_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limit_cooldowns_expires ON rate_limit_cooldowns(expires_at_ms);

    -- Hourly roll-up read by the MCP surface and pruned by retention; new
    -- traffic lands in analytics_hourly, this keeps the legacy readers whole.
    CREATE TABLE IF NOT EXISTS request_hourly (
      hour TEXT PRIMARY KEY,
      total_requests INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0
    );
  `);
}

export async function down(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(`
    DROP INDEX IF EXISTS idx_key_monthly_usage_month;
    DROP INDEX IF EXISTS idx_api_keys_platform;
    DROP INDEX IF EXISTS idx_requests_created_at;
    DROP INDEX IF EXISTS idx_rate_limit_usage_lookup;
    DROP INDEX IF EXISTS idx_rate_limit_cooldowns_expires;
    DROP TRIGGER IF EXISTS requests_key_monthly_usage ON requests;
    DROP FUNCTION IF EXISTS update_key_monthly_usage();
    DROP TABLE IF EXISTS request_hourly;
    DROP TABLE IF EXISTS rate_limit_cooldowns;
    DROP TABLE IF EXISTS rate_limit_usage;
    DROP TABLE IF EXISTS requests;
    DROP TABLE IF EXISTS api_keys;
    DROP TABLE IF EXISTS key_monthly_usage;
    ALTER TABLE credentials DROP COLUMN IF EXISTS monthly_request_cap;
    ALTER TABLE credentials DROP COLUMN IF EXISTS monthly_token_cap;
  `);
}
