import { describe, expect, it, afterEach } from 'vitest';
import { createPostgresPool, initPostgresPool, closePostgresPool } from '../../db/postgres.js';

// The real pg pool used to attach SQLite-compat shims that ran statements
// against a throwaway in-memory Map: `prepare().run()` reported `{changes:1}`
// while the row never reached Postgres, `transaction(fn)` was `(fn)=>fn` (no
// BEGIN/COMMIT/ROLLBACK), and `exec()` was a no-op. Every compat feature was a
// silent fake in production. These pin the fail-loud replacement: the shims
// throw instead of fabricating success, so an unported call site is loud, not
// silently wrong. (Mock/test pool keeps working `prepare` — covered elsewhere.)
describe('real Postgres pool refuses SQLite compatibility APIs', () => {
  afterEach(async () => {
    await closePostgresPool();
  });

  // A syntactically valid URL is enough: pg.Pool is lazy and does not connect
  // until a query, and the shims are attached at construction.
  const realPool = () => createPostgresPool('postgresql://user:pass@127.0.0.1:5432/never_connected') as any;

  it('prepare(...).run() throws instead of reporting a fake write', () => {
    const pool = realPool();
    const stmt = pool.prepare("INSERT INTO profiles (name) VALUES ('x')");
    expect(() => stmt.run()).toThrow(/SQLite compatibility API/);
    expect(() => stmt.run()).toThrow(/await pool\.query/);
  });

  it('prepare(...).get() and .all() throw instead of returning fabricated rows', () => {
    const pool = realPool();
    const stmt = pool.prepare('SELECT id FROM profiles');
    expect(() => stmt.get()).toThrow(/SQLite compatibility API/);
    expect(() => stmt.all()).toThrow(/SQLite compatibility API/);
  });

  it('the thrown message names the offending SQL for actionable reports', () => {
    const pool = realPool();
    expect(() => pool.prepare('SELECT 1 FROM api_keys').all()).toThrow(/api_keys/);
  });

  it('transaction(fn) throws instead of silently omitting boundaries', () => {
    const pool = realPool();
    expect(() => pool.transaction(async () => 1)).toThrow(/SQLite compatibility API/);
    expect(() => pool.transaction(async () => 1)).toThrow(/transaction/);
  });

  it('exec() and pragma() throw instead of no-op faking', () => {
    const pool = realPool();
    expect(() => pool.exec('CREATE TABLE t (id int)')).toThrow(/SQLite compatibility API/);
    expect(() => pool.pragma('journal_mode')).toThrow(/SQLite compatibility API/);
  });

  it('the mock pool (NODE_ENV=test, no USE_REAL_POSTGRES) still exposes working prepare', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.USE_REAL_POSTGRES;
    await closePostgresPool();
    const mock = initPostgresPool(':memory:') as any;
    expect(mock.isMock()).toBe(true);
    // The mock keeps a synchronous prepare that does not throw.
    const stmt = mock.prepare('SELECT 1 AS one');
    expect(() => stmt.all()).not.toThrow();
  });
});

// G1: under USE_REAL_POSTGRES the suite still passes ':memory:'; it must resolve
// to DATABASE_URL rather than building a pool from the literal string, so the
// same tests can target a disposable real Postgres.
describe('USE_REAL_POSTGRES resolves :memory: to DATABASE_URL', () => {
  afterEach(async () => {
    await closePostgresPool();
    delete process.env.USE_REAL_POSTGRES;
    delete process.env.DATABASE_URL;
  });

  it('throws a clear config error when USE_REAL_POSTGRES is set but no URL is available', async () => {
    process.env.NODE_ENV = 'test';
    process.env.USE_REAL_POSTGRES = '1';
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.PG_DATABASE_URL;
    await closePostgresPool();
    // Must NOT be the ":memory:" string reaching pg; must be the missing-URL diagnostic.
    expect(() => initPostgresPool(':memory:')).toThrow(/DATABASE_URL environment variable is required/);
  });
});
