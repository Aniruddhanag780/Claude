export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

export interface RunResult {
  /** Number of rows affected by an INSERT/UPDATE/DELETE. */
  changes: number;
  /**
   * Generated identifier when the statement was written with a `RETURNING`
   * clause (PostgreSQL has no SQLite-style `last_insert_rowid()`), otherwise
   * undefined. Call sites that need the new id append `RETURNING id`.
   */
  lastInsertRowid?: number | bigint;
}

/**
 * Asynchronous database contract backed by PostgreSQL (Neon).
 *
 * Every method returns a Promise; there is deliberately no synchronous
 * `prepare()` API — `pg` cannot produce synchronous results, and faking them
 * would hide real latency behind fabricated values.
 *
 * SQL is written in the upstream SQLite-flavoured style: positional `?`
 * placeholders. The driver translates them to PostgreSQL's `$1..$n` and
 * skips string/identifier/comment literals so existing queries stay intact.
 */
export interface Db {
  /** Execute a parameterized query and return every row. */
  query<T = any>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  /** First matching row, or undefined when none match. */
  get<T = any>(sql: string, params?: readonly unknown[]): Promise<T | undefined>;
  /** All matching rows (empty array when none match). */
  all<T = any>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Execute a write; resolves with affected-row info (and id via RETURNING). */
  run(sql: string, params?: readonly unknown[]): Promise<RunResult>;
  /** Execute one or more statements (typically DDL). Parameters unsupported. */
  exec(sql: string): Promise<void>;
  /**
   * Run `fn` inside a single transaction bound to one dedicated connection.
   * Every query issued through the `tx` handle participates in that
   * transaction; committing and rolling back is owned by this method.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  /** Release the underlying pool/connections. Safe to call more than once. */
  close(): Promise<void>;
}
