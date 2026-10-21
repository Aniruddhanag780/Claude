import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb } from '../../db/index.js';
import { getRequestAnalyticsRetentionConfig, pruneRequestAnalytics } from '../../services/request-retention.js';
import { initTestDb } from '../helpers/test-db.js';

const ORIGINAL_RETENTION_DAYS = process.env.REQUEST_ANALYTICS_RETENTION_DAYS;
const ORIGINAL_MAX_ROWS = process.env.REQUEST_ANALYTICS_MAX_ROWS;
const ORIGINAL_SEARCH_LOGS_RETENTION_DAYS = process.env.SEARCH_LOGS_RETENTION_DAYS;
const ORIGINAL_SEARCH_LOGS_MAX_ROWS = process.env.SEARCH_LOGS_MAX_ROWS;
const ORIGINAL_DECISION_LOGS_RETENTION_DAYS = process.env.DECISION_LOGS_RETENTION_DAYS;
const ORIGINAL_DECISION_LOGS_MAX_ROWS = process.env.DECISION_LOGS_MAX_ROWS;

function restoreEnv() {
  if (ORIGINAL_DECISION_LOGS_RETENTION_DAYS === undefined) {
    delete process.env.DECISION_LOGS_RETENTION_DAYS;
  } else {
    process.env.DECISION_LOGS_RETENTION_DAYS = ORIGINAL_DECISION_LOGS_RETENTION_DAYS;
  }

  if (ORIGINAL_DECISION_LOGS_MAX_ROWS === undefined) {
    delete process.env.DECISION_LOGS_MAX_ROWS;
  } else {
    process.env.DECISION_LOGS_MAX_ROWS = ORIGINAL_DECISION_LOGS_MAX_ROWS;
  }

  if (ORIGINAL_SEARCH_LOGS_RETENTION_DAYS === undefined) {
    delete process.env.SEARCH_LOGS_RETENTION_DAYS;
  } else {
    process.env.SEARCH_LOGS_RETENTION_DAYS = ORIGINAL_SEARCH_LOGS_RETENTION_DAYS;
  }

  if (ORIGINAL_SEARCH_LOGS_MAX_ROWS === undefined) {
    delete process.env.SEARCH_LOGS_MAX_ROWS;
  } else {
    process.env.SEARCH_LOGS_MAX_ROWS = ORIGINAL_SEARCH_LOGS_MAX_ROWS;
  }

  if (ORIGINAL_RETENTION_DAYS === undefined) {
    delete process.env.REQUEST_ANALYTICS_RETENTION_DAYS;
  } else {
    process.env.REQUEST_ANALYTICS_RETENTION_DAYS = ORIGINAL_RETENTION_DAYS;
  }

  if (ORIGINAL_MAX_ROWS === undefined) {
    delete process.env.REQUEST_ANALYTICS_MAX_ROWS;
  } else {
    process.env.REQUEST_ANALYTICS_MAX_ROWS = ORIGINAL_MAX_ROWS;
  }
}

async function insertRequest(createdAt: string, marker: string) {
  (await getDb().run(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
    VALUES ('groq', 'groq/compound', 1, 'error', 0, 0, 10, ?, ?) RETURNING id`, [marker, createdAt]));
}

describe('request analytics retention', () => {
  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
    (await getDb().run('DELETE FROM requests'));
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('uses conservative defaults when env values are absent or invalid', () => {
    delete process.env.REQUEST_ANALYTICS_RETENTION_DAYS;
    delete process.env.REQUEST_ANALYTICS_MAX_ROWS;
    expect(getRequestAnalyticsRetentionConfig()).toEqual({ retentionDays: 90, maxRows: 100000 });

    process.env.REQUEST_ANALYTICS_RETENTION_DAYS = 'bad';
    process.env.REQUEST_ANALYTICS_MAX_ROWS = '-1';
    expect(getRequestAnalyticsRetentionConfig()).toEqual({ retentionDays: 90, maxRows: 100000 });
  });

  it('deletes request analytics older than the configured retention window', async () => {
    process.env.REQUEST_ANALYTICS_RETENTION_DAYS = '7';
    process.env.REQUEST_ANALYTICS_MAX_ROWS = '0';

    await insertRequest('2026-05-01 00:00:00', 'old');
    await insertRequest('2026-05-25 00:00:00', 'recent');

    const result = await pruneRequestAnalytics({
      db: getDb(),
      force: true,
      now: new Date('2026-05-26T00:00:00Z'),
    });

    expect(result.deleted).toBe(1);
    const rows = (await getDb().all('SELECT error FROM requests ORDER BY id')) as Array<{ error: string }>;
    expect(rows.map(row => row.error)).toEqual(['recent']);
  });

  it('keeps only the newest configured number of request rows', async () => {
    process.env.REQUEST_ANALYTICS_RETENTION_DAYS = '0';
    process.env.REQUEST_ANALYTICS_MAX_ROWS = '2';

    await insertRequest('2026-05-01 00:00:00', 'row-1');
    await insertRequest('2026-05-02 00:00:00', 'row-2');
    await insertRequest('2026-05-03 00:00:00', 'row-3');
    await insertRequest('2026-05-04 00:00:00', 'row-4');

    const result = await pruneRequestAnalytics({
      db: getDb(),
      force: true,
      now: new Date('2026-05-26T00:00:00Z'),
    });

    expect(result.deleted).toBe(2);
    const rows = (await getDb().all('SELECT error FROM requests ORDER BY created_at ASC')) as Array<{ error: string }>;
    expect(rows.map(row => row.error)).toEqual(['row-3', 'row-4']);
  });

  it('prunes hourly aggregate rows older than 30 days and only when the daily gate has elapsed', async () => {
    // Hourly buckets never auto-create themselves in this test (logRequest is
    // the only writer), so seed them by hand to exercise the prune path.
    const db = getDb();
    (await db.run(`CREATE TABLE IF NOT EXISTS request_hourly (
      hour TEXT PRIMARY KEY, total_requests INTEGER NOT NULL DEFAULT 0
    )`));
    // Seed in the same 'YYYY-MM-DD HH:00:00' (space) format production writes,
    // so the prune cutoff (also space) compares apples-to-apples.
    (await db.run(`INSERT INTO request_hourly (hour, total_requests) VALUES (?, ?)
      ON CONFLICT(hour) DO UPDATE SET total_requests = excluded.total_requests`, ['2026-05-01 00:00:00', 5]));   // outside 30d window from May 31
    (await db.run(`INSERT INTO request_hourly (hour, total_requests) VALUES (?, ?)
      ON CONFLICT(hour) DO UPDATE SET total_requests = excluded.total_requests`, ['2026-05-15 00:00:00', 3]));   // inside
    (await db.run(`INSERT INTO request_hourly (hour, total_requests) VALUES (?, ?)
      ON CONFLICT(hour) DO UPDATE SET total_requests = excluded.total_requests`, ['2026-05-31 00:00:00', 7]));   // boundary hour, kept

    // First call (cold gate): should prune the May 1 row and leave the rest.
    const first = await pruneRequestAnalytics({
      db,
      force: true,
      now: new Date('2026-05-31T01:00:00Z'),
    });
    expect(first.deleted).toBe(1);
    const remaining = (await db.all(`SELECT hour, total_requests FROM request_hourly ORDER BY hour`)) as Array<{ hour: string; total_requests: number }>;
    expect(remaining.map(r => r.hour)).toEqual(['2026-05-15 00:00:00', '2026-05-31 00:00:00']);

    // Second call inside the 24h gate: hourly prune is skipped (raw prune may
    // still run, but with default config + 0 rows it deletes nothing). The
    // hourly rows are unchanged.
    const second = await pruneRequestAnalytics({
      db,
      now: new Date('2026-05-31T01:05:00Z'),
    });
    expect(second.skipped).toBe(false);
    expect(second.deleted).toBe(0);
    const remainingAfter = (await db.all(`SELECT hour FROM request_hourly ORDER BY hour`)) as Array<{ hour: string }>;
    expect(remainingAfter.map(r => r.hour)).toEqual(['2026-05-15 00:00:00', '2026-05-31 00:00:00']);
  });

  it('sweeps expired idempotency claims and cache rows on the prune pass', async () => {
    // Both tables ship with the migration set; seed one expired and one live
    // row in each so a prune must keep the live half.
    const db = getDb();
    const now = new Date('2026-05-31T00:00:00Z').getTime();
    (await db.run(`
      INSERT INTO idempotency_claims (key_hash, request_fingerprint, response_status, response_body, created_at_ms, expires_at_ms)
      VALUES (?, 'fp', 200, '{}', ?, ?) RETURNING id`, ['hash-expired', now - 48 * 3600_000, now - 3600_000]));
    (await db.run(`
      INSERT INTO idempotency_claims (key_hash, request_fingerprint, response_status, response_body, created_at_ms, expires_at_ms)
      VALUES (?, 'fp', 200, '{}', ?, ?) RETURNING id`, ['hash-live', now - 3600_000, now + 3600_000]));
    (await db.run(`
      INSERT INTO response_cache (cache_key, body_json, platform, model_id, prompt_tokens, completion_tokens, created_at_ms, expires_at_ms)
      VALUES (?, '{}', 'groq', 'grok-test', 1, 1, ?, ?)
    `, ['cache-expired', now - 48 * 3600_000, now - 1000]));
    (await db.run(`
      INSERT INTO response_cache (cache_key, body_json, platform, model_id, prompt_tokens, completion_tokens, created_at_ms, expires_at_ms)
      VALUES (?, '{}', 'groq', 'grok-test', 1, 1, ?, ?)
    `, ['cache-live', now - 1000, now + 60_000]));

    const result = await pruneRequestAnalytics({ db, force: true, now: new Date(now) });
    expect(result.deleted).toBe(2);
    expect(((await db.get("SELECT COUNT(*) AS n FROM idempotency_claims WHERE key_hash = 'hash-expired'")) as { n: number }).n).toBe(0);
    expect(((await db.get("SELECT COUNT(*) AS n FROM idempotency_claims WHERE key_hash = 'hash-live'")) as { n: number }).n).toBe(1);
    expect(((await db.get("SELECT COUNT(*) AS n FROM response_cache WHERE cache_key = 'cache-expired'")) as { n: number }).n).toBe(0);
    expect(((await db.get("SELECT COUNT(*) AS n FROM response_cache WHERE cache_key = 'cache-live'")) as { n: number }).n).toBe(1);
  });

  it('sweeps expired dashboard sessions on the prune pass', async () => {
    // Expired session rows used to be uncollectable: validateSession only
    // deletes the row it is validating, and an expired token is never re-sent,
    // while every login mints a fresh row. Seed one of each and require the
    // prune to take only the expired half.
    const db = getDb();
    const now = new Date('2026-05-31T00:00:00Z').getTime();
    const userId = ((await db.run("INSERT INTO users (email, password_hash) VALUES ('prune@example.com', 'x') RETURNING id"))).lastInsertRowid as number;
    (await db.run('INSERT INTO sessions (token_hash, user_id, expires_at_ms) VALUES (?, ?, ?)', ['hash-expired-session', userId, now - 1000]));
    (await db.run('INSERT INTO sessions (token_hash, user_id, expires_at_ms) VALUES (?, ?, ?)', ['hash-live-session', userId, now + 3600_000]));

    const result = await pruneRequestAnalytics({ db, force: true, now: new Date(now) });
    expect(result.deleted).toBe(1);
    expect(((await db.get("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = 'hash-expired-session'")) as { n: number }).n).toBe(0);
    expect(((await db.get("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = 'hash-live-session'")) as { n: number }).n).toBe(1);
  });

  it('bounds the web-search attempt log by age and count', async () => {
    process.env.SEARCH_LOGS_RETENTION_DAYS = '7';
    process.env.SEARCH_LOGS_MAX_ROWS = '2';
    const db = getDb();
    (await db.run(`
      INSERT INTO search_requests (engine_id, platform, status, latency_ms, created_at)
      VALUES ('tavily-search', 'tavily', 'ok', 10, ?) RETURNING id`, ['2026-05-01 00:00:00'])); // older than 7d from May 8
    (await db.run(`
      INSERT INTO search_requests (engine_id, platform, status, latency_ms, created_at)
      VALUES ('tavily-search', 'tavily', 'ok', 10, ?) RETURNING id`, ['2026-05-07 00:00:00']));
    (await db.run(`
      INSERT INTO search_requests (engine_id, platform, status, latency_ms, created_at)
      VALUES ('tavily-search', 'tavily', 'ok', 10, ?) RETURNING id`, ['2026-05-07 23:00:00']));
    (await db.run(`
      INSERT INTO search_requests (engine_id, platform, status, latency_ms, created_at)
      VALUES ('tavily-search', 'tavily', 'ok', 10, ?) RETURNING id`, ['2026-05-08 00:00:00']));

    const result = await pruneRequestAnalytics({
      db,
      force: true,
      now: new Date('2026-05-08T12:00:00Z'),
    });
    // Age prune drops May 1; the count cap then trims the rest to the newest 2.
    expect(result.deleted).toBe(2);
    const remaining = (await db.all(`SELECT created_at FROM search_requests ORDER BY created_at`)) as Array<{ created_at: string }>;
    expect(remaining.map(r => r.created_at)).toEqual(['2026-05-07 23:00:00', '2026-05-08 00:00:00']);
  });

  it('keeps search rows when both knobs are 0', async () => {
    process.env.SEARCH_LOGS_RETENTION_DAYS = '0';
    process.env.SEARCH_LOGS_MAX_ROWS = '0';
    const db = getDb();
    (await db.run(`INSERT INTO search_requests (engine_id, platform, status, latency_ms, created_at)
      VALUES ('tavily-search', 'tavily', 'ok', 10, '2020-01-01 00:00:00') RETURNING id`));

    await pruneRequestAnalytics({ db, force: true, now: new Date('2026-05-08T12:00:00Z') });
    expect(((await db.get('SELECT COUNT(*) AS n FROM search_requests')) as { n: number }).n).toBe(1);
  });

  it('bounds the decision-model attempt log by age and count', async () => {
    process.env.DECISION_LOGS_RETENTION_DAYS = '7';
    process.env.DECISION_LOGS_MAX_ROWS = '2';
    const db = getDb();
    (await db.run(`
      INSERT INTO decision_requests (model_id, platform, status, latency_ms, created_at)
      VALUES ('clef-flash', 'cloudflare', 'ok', 10, ?) RETURNING id`, ['2026-05-01 00:00:00'])); // older than 7d from May 8
    (await db.run(`
      INSERT INTO decision_requests (model_id, platform, status, latency_ms, created_at)
      VALUES ('clef-flash', 'cloudflare', 'ok', 10, ?) RETURNING id`, ['2026-05-07 00:00:00']));
    (await db.run(`
      INSERT INTO decision_requests (model_id, platform, status, latency_ms, created_at)
      VALUES ('clef-flash', 'cloudflare', 'ok', 10, ?) RETURNING id`, ['2026-05-07 23:00:00']));
    (await db.run(`
      INSERT INTO decision_requests (model_id, platform, status, latency_ms, created_at)
      VALUES ('clef-flash', 'cloudflare', 'ok', 10, ?) RETURNING id`, ['2026-05-08 00:00:00']));

    const result = await pruneRequestAnalytics({
      db,
      force: true,
      now: new Date('2026-05-08T12:00:00Z'),
    });
    // Age prune drops May 1; the count cap then trims the rest to the newest 2.
    expect(result.deleted).toBe(2);
    const remaining = (await db.all(`SELECT created_at FROM decision_requests ORDER BY created_at`)) as Array<{ created_at: string }>;
    expect(remaining.map(r => r.created_at)).toEqual(['2026-05-07 23:00:00', '2026-05-08 00:00:00']);
  });

  it('keeps decision rows when both knobs are 0', async () => {
    process.env.DECISION_LOGS_RETENTION_DAYS = '0';
    process.env.DECISION_LOGS_MAX_ROWS = '0';
    const db = getDb();
    (await db.run(`INSERT INTO decision_requests (model_id, platform, status, latency_ms, created_at)
      VALUES ('clef-flash', 'cloudflare', 'ok', 10, '2020-01-01 00:00:00') RETURNING id`));

    await pruneRequestAnalytics({ db, force: true, now: new Date('2026-05-08T12:00:00Z') });
    expect(((await db.get('SELECT COUNT(*) AS n FROM decision_requests')) as { n: number }).n).toBe(1);
  });
});
