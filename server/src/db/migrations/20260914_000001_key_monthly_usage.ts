import type { Db } from '../types.js';

/** A durable ledger: pruning analytics must never reopen a spent monthly cap. */
export async function up(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS key_monthly_usage (
      key_id BIGINT NOT NULL,
      month TEXT NOT NULL,
      requests BIGINT NOT NULL DEFAULT 0,
      tokens BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (key_id, month)
    );
    INSERT INTO key_monthly_usage (key_id, month, requests, tokens)
    SELECT key_id, to_char(created_at::timestamp, 'YYYY-MM'), COUNT(*),
           SUM(GREATEST(0, input_tokens) + GREATEST(0, output_tokens))
      FROM requests
     WHERE key_id IS NOT NULL AND status = 'success'
       AND to_char(created_at::timestamp, 'YYYY-MM') IS NOT NULL
     GROUP BY key_id, to_char(created_at::timestamp, 'YYYY-MM')
    ON CONFLICT(key_id, month) DO NOTHING;
  `);

  // SQLite's `CREATE TRIGGER ... BEGIN ... END` has no PostgreSQL equivalent as
  // a single statement: PostgreSQL needs a trigger function plus the trigger
  // that calls it. `MAX(a, b)` is `GREATEST(a, b)`; `to_char(ts::timestamp, 'YYYY-MM')` is
  // `to_char(ts, 'YYYY-MM')`.
  await db.exec(`
    CREATE OR REPLACE FUNCTION requests_key_monthly_usage_fn()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF NEW.key_id IS NOT NULL AND NEW.status = 'success'
         AND to_char(NEW.created_at::timestamp, 'YYYY-MM') IS NOT NULL THEN
        INSERT INTO key_monthly_usage (key_id, month, requests, tokens)
        VALUES (NEW.key_id, to_char(NEW.created_at::timestamp, 'YYYY-MM'), 1,
                GREATEST(0, NEW.input_tokens) + GREATEST(0, NEW.output_tokens))
        ON CONFLICT(key_id, month) DO UPDATE SET
          requests = key_monthly_usage.requests + 1,
          tokens = key_monthly_usage.tokens + EXCLUDED.tokens;
      END IF;
      RETURN NEW;
    END;
    $fn$;

    DROP TRIGGER IF EXISTS requests_key_monthly_usage ON requests;
    CREATE TRIGGER requests_key_monthly_usage
    AFTER INSERT ON requests
    FOR EACH ROW
    EXECUTE FUNCTION requests_key_monthly_usage_fn();
  `);
}

export async function down(db: Db): Promise<void> {
  await db.exec(`
    DROP TRIGGER IF EXISTS requests_key_monthly_usage ON requests;
    DROP FUNCTION IF EXISTS requests_key_monthly_usage_fn();
    DROP TABLE IF EXISTS key_monthly_usage;
  `);
}
