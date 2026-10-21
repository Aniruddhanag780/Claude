import pg from 'pg';

import type { Db, QueryResult, RunResult } from './types.js';

const { Pool } = pg;

/**
 * SQLite's `INTEGER` is a 64-bit integer that JavaScript reads as a number.
 * PostgreSQL's `bigint` (int8) comes back from node-postgres as a *string* by
 * default, so every migrated read would see `"3"` where the SQLite code saw
 * `3` — which silently turns arithmetic into string concatenation
 * (`"3" + 1 + 1` is `"311"`, not `5`) and breaks COUNT(*) comparisons.
 *
 * Parse int8 and numeric back to numbers, matching the SQLite behaviour the
 * upstream code was written against. This mirrors what SQLite itself did: a
 * 64-bit integer beyond 2^53 already lost precision in the JavaScript number
 * it was stored in, so nothing is given up here.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => (v === null ? null : Number(v)) as unknown as string);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v: string) => (v === null ? null : Number(v)) as unknown as string);
pg.types.setTypeParser(1016 as unknown as Parameters<typeof pg.types.setTypeParser>[0], ((v: string) => (v === null ? null : v.replace(/[{}]/g, '').split(',').map(Number))) as unknown as (v: string) => string);
pg.types.setTypeParser(1231 as unknown as Parameters<typeof pg.types.setTypeParser>[0], ((v: string) => (v === null ? null : v.replace(/[{}]/g, '').split(',').map(Number))) as unknown as (v: string) => string);

export interface SslResolution {
  /** Value for pg.PoolConfig.ssl. `undefined` means "let the driver decide" (used
   *  when the connection string already carries an explicit sslmode, which
   *  pg-connection-string applies itself). */
  ssl?: pg.PoolConfig['ssl'];
  /** Human-readable note for startup logs (why this choice was made). */
  reason: string;
}

/**
 * Decide the TLS setting for a Postgres connection, verifying the server
 * certificate by default.
 *
 * Precedence (mirrors how node-postgres actually behaves — `pg` merges the
 * parsed connection string OVER programmatic config, so an explicit `sslmode`
 * in DATABASE_URL always wins):
 *
 *   1. Explicit `sslmode` / `sslrootcert` / `sslcert` / `sslkey` in the URL
 *      → return `ssl: undefined` so pg-connection-string applies the URL
 *         verbatim. We never second-guess an explicit operator setting, and we
 *         never fight it with a conflicting programmatic value.
 *   2. No URL SSL params, host is local (localhost / 127.0.0.1 / ::1)
 *      → `ssl: undefined` (plain connection). Local dev Postgres typically
 *         speaks no TLS; forcing it would break `docker run postgres`.
 *   3. No URL SSL params, non-local host (production / Neon / managed)
 *      → `ssl: { rejectUnauthorized: true }`: encrypt AND verify the server
 *         certificate and hostname against the system CA store. Neon's
 *         certificate is signed by a public CA, so this works out of the box.
 *
 * Escape hatch (explicit, off by default): set PGSSL_NO_VERIFY=true to connect
 * to a non-local server with a self-signed / private-CA certificate without
 * verification. This is the ONLY path that disables verification, it is never
 * the default, and it logs a warning so it cannot be enabled silently.
 */
export function resolveSslConfig(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): SslResolution {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ssl: undefined, reason: 'unparsable connection string; leaving SSL to the driver' };
  }

  // 1. An explicit SSL setting in the URL is authoritative — do not override it.
  const params = parsed.searchParams;
  const explicit =
    params.has('sslmode') ||
    params.has('sslrootcert') ||
    params.has('sslcert') ||
    params.has('sslkey') ||
    params.has('ssl');
  if (explicit) {
    return {
      ssl: undefined,
      reason: 'connection string carries an explicit sslmode/ssl* setting; honouring it verbatim',
    };
  }

  // 2. Local development hosts: no TLS unless the operator asked for it above.
  const host = (parsed.hostname || '').toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (isLocal) {
    return { ssl: undefined, reason: 'local host without explicit sslmode; using a plain connection' };
  }

  // 3. Non-local (production / Neon / managed): verify the certificate.
  const noVerify = /^(1|true|yes)$/i.test(env.PGSSL_NO_VERIFY ?? '');
  if (noVerify) {
    console.warn(
      '[db] PGSSL_NO_VERIFY is set: TLS certificate verification is DISABLED for this non-local Postgres. ' +
        'Traffic is encrypted but the server is not authenticated (vulnerable to MITM). Unset it unless you ' +
        'control the CA (e.g. a self-signed dev server).',
    );
    return {
      ssl: { rejectUnauthorized: false },
      reason: 'PGSSL_NO_VERIFY=true: encrypted but not verified (explicit opt-out)',
    };
  }

  return {
    ssl: { rejectUnauthorized: true },
    reason: 'non-local host: TLS enabled with certificate + hostname verification (system CA store)',
  };
}

/**
 * Translate SQLite-style positional `?` placeholders into PostgreSQL's
 * `$1..$n`, leaving string literals, quoted identifiers, comments, and
 * dollar-quoted bodies untouched so a `?` inside text stays literal.
 *
 * Returns the rewritten SQL and how many placeholders were bound, which the
 * driver cross-checks against the supplied parameter count.
 */
export function translatePlaceholders(sql: string): { text: string; count: number; named: string[] } {
  let out = '';
  let param = 0;
  let maxDollar = 0;
  const named: string[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    // Single-quoted string literal / double-quoted identifier.
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        out += sql[i];
        if (sql[i] === quote) {
          if (i + 1 < n && sql[i + 1] === quote) {
            // Doubled quote is an escaped quote, not a terminator.
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // Line comment.
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') {
        out += sql[i];
        i += 1;
      }
      continue;
    }

    // Block comment.
    if (ch === '/' && sql[i + 1] === '*') {
      out += sql[i] + sql[i + 1];
      i += 2;
      while (i < n) {
        out += sql[i];
        if (sql[i] === '*' && sql[i + 1] === '/') {
          out += sql[i + 1];
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }

    // Dollar-quoted body ($tag$ ... $tag$), PostgreSQL-specific.
    if (ch === '$') {
      const m = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        out += tag;
        i += tag.length;
        const end = sql.indexOf(tag, i);
        if (end === -1) {
          out += sql.slice(i);
          i = n;
          continue;
        }
        out += sql.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
      // Native PG positional placeholder $N (kept verbatim; track the highest
      // index so the parameter-count guard accepts SQL already written for PG).
      const ph = /^\$(\d+)/.exec(sql.slice(i));
      if (ph) {
        maxDollar = Math.max(maxDollar, Number(ph[1]));
        out += ph[0];
        i += ph[0].length;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '?') {
      param += 1;
      out += `$${param}`;
      i += 1;
      continue;
    }

    // better-sqlite3 named placeholder @name → $N (first-appearance order).
    if (ch === '@') {
      const nm = /^@([A-Za-z_][A-Za-z_0-9]*)/.exec(sql.slice(i));
      if (nm) {
        const name = nm[1];
        let idx = named.indexOf(name);
        if (idx === -1) {
          named.push(name);
          idx = named.length - 1;
        }
        out += `$${idx + 1}`;
        i += nm[0].length;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  // Mixing styles in one statement would renumber `?` onto a colliding $N.
  if (param > 0 && (maxDollar > 0 || named.length > 0)) {
    throw new Error('[db] mixing ? placeholders with $N/@name in one statement is not supported');
  }
  // Named-param SQL is driven by the object's keys (count = distinct names);
  // otherwise the count is the number of bound positions (`?` and/or max `$N`).
  const count = named.length > 0 ? named.length : Math.max(param, maxDollar);
  return { text: out, count, named };
}

/** True for a plain object (the single-argument form of a named-param call). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Anything that can run a query: the shared pool, or a dedicated tx client. */
type Executor = pg.Pool | pg.PoolClient;

export interface PgDbOptions {
  /** Report why this TLS choice was made (surfaced once at startup). */
  onSslInfo?: (info: SslResolution) => void;
}

/**
 * Create the shared application pool. Connection parameters come from
 * DATABASE_URL; the pool is deliberately small for Render/Neon free tier.
 */
export function createPgPool(connectionString: string): pg.Pool {
  const tls = resolveSslConfig(connectionString);

  const poolConfig: pg.PoolConfig = {
    connectionString,
    max: Number(process.env.PG_MAX_CONNECTIONS || 10),
    // Env overrides exist for tests (fake timers) and high-latency setups;
    // 0 disables the timer entirely.
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 10_000),
  };
  if (tls.ssl !== undefined) {
    poolConfig.ssl = tls.ssl;
  }

  const pool = new Pool(poolConfig);

  // A pool-level error (e.g. server went away on an idle connection) must not
  // crash the process; pg already discards the broken client. Log, don't throw.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });

  return pool;
}

/**
 * PostgreSQL implementation of the async {@link Db} contract.
 *
 * Bound either to the shared pool (normal queries) or to a single checked-out
 * client (inside a transaction, so every statement shares one connection).
 */
export class PgDb implements Db {
  private readonly executor: Executor;
  /** True when bound to a single checked-out client (i.e. inside a transaction). */
  private readonly isClient: boolean;
  private ownsExecutor: boolean;
  /** Unique-name source for nested SAVEPOINTs. */
  private savepointSeq = 0;

  constructor(executor: Executor, ownsExecutor = false) {
    this.executor = executor;
    // A pool has no release(); a checked-out client does. That distinction is
    // what tells us whether transaction() should BEGIN or emit a SAVEPOINT.
    this.isClient = typeof (executor as { release?: unknown }).release === 'function';
    this.ownsExecutor = ownsExecutor;
  }

  private async runQuery<T>(sql: string, params: readonly unknown[]): Promise<QueryResult<T>> {
    const { text, count, named } = translatePlaceholders(sql);
    let bound: readonly unknown[];
    if (named.length > 0 && params.length === 1 && isPlainObject(params[0])) {
      // better-sqlite3 convention: a single object supplies named params by key.
      const obj = params[0] as Record<string, unknown>;
      bound = named.map((name) => {
        if (!(name in obj)) throw new Error(`[db] missing named parameter @${name}`);
        return obj[name];
      });
    } else {
      bound = params;
    }
    if (bound.length !== count) {
      throw new Error(
        `[db] placeholder/parameter mismatch: SQL needs ${count} param(s) but ${bound.length} were supplied.\n` +
          `SQL: ${sql.trim().slice(0, 200)}`,
      );
    }
    const res = await this.executor.query(text, bound as unknown[]);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
  }

  async query<T = any>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    return await this.runQuery<T>(sql, params);
  }

  async get<T = any>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    const res = await this.runQuery<T>(sql, params);
    return res.rows[0];
  }

  async all<T = any>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const res = await this.runQuery<T>(sql, params);
    return res.rows;
  }

  async run(sql: string, params: readonly unknown[] = []): Promise<RunResult> {
    const res = await this.runQuery(sql, params);
    const first = res.rows[0] as Record<string, unknown> | undefined;
    const generatedId = first && 'id' in first ? (first.id as number | bigint) : undefined;
    return {
      changes: res.rowCount ?? 0,
      ...(generatedId !== undefined ? { lastInsertRowid: generatedId } : {}),
    };
  }

  async exec(sql: string): Promise<void> {
    const { text } = translatePlaceholders(sql);
    await this.executor.query(text);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // Top-level: check a client out of the pool and wrap it in BEGIN/COMMIT.
    if (!this.isClient) {
      const pool = this.executor as pg.Pool;
      const client = await pool.connect();
      const tx = new PgDb(client);
      try {
        await client.query('BEGIN');
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          console.error('[db] rollback failed:', (rollbackErr as Error).message);
        }
        throw err;
      } finally {
        client.release();
      }
    }

    // Nested: already on a single connection inside an outer transaction, so
    // use a SAVEPOINT (mirrors better-sqlite3's nested-transaction semantics
    // that the legacy baseline migration relies on).
    const client = this.executor as pg.PoolClient;
    const savepoint = `sp_${++this.savepointSeq}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await fn(this);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (err) {
      try {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (rollbackErr) {
        console.error('[db] savepoint rollback failed:', (rollbackErr as Error).message);
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.ownsExecutor && 'end' in this.executor) {
      await (this.executor as pg.Pool).end();
      this.ownsExecutor = false;
    }
  }
}
