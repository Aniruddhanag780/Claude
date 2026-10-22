import { describe, it, expect, afterEach } from 'vitest';
import { connectDb, closeDb } from '../../db/index.js';
import { createPgPool, PgDb } from '../../db/pg.js';
import { initTestDb } from '../helpers/test-db.js';

// The SQLite-era `connectDb(path, { factory, ensureDir })` injection point is
// gone: PostgreSQL has no database file to open, and the pool is built from a
// connection string. The injection point that survives is the Db itself —
// `new PgDb(createPgPool(url), true)` — and that is exactly what the test
// harness uses to give every test file its own database.
//
// What must hold on PG:
//   * connectDb() is a singleton: a second call hands back the same Db rather
//     than opening a second pool;
//   * an explicit connection string wins over the environment;
//   * an independently constructed Db is fully independent of the singleton —
//     closing it must not disturb the process-wide pool;
//   * none of it creates anything on disk.

afterEach(async () => {
  await closeDb().catch(() => { /* not connected */ });
});

describe('connectDb — pool injection on PG', () => {
  it('is a singleton: a second call reuses the same Db and pool', async () => {
    await initTestDb();
    const first = await connectDb();
    const second = await connectDb();
    expect(second).toBe(first);
  });

  it('uses an explicit connection string instead of the environment', async () => {
    const url = process.env.TEST_DATABASE_URL;
    expect(url).toBeTruthy();
    await initTestDb();

    const db = await connectDb(url);
    const row = await db.get<{ ok: number }>('SELECT 1 AS ok');
    expect(row).toEqual({ ok: 1 });
  });

  it('lets an independently built Db coexist with the singleton', async () => {
    await initTestDb();
    const shared = await connectDb();

    // The harness's own injection point: a separate pool over a separate
    // database, owning its executor.
    const { db, cleanup } = await import('../helpers/test-db.js').then((m) => m.createEmptyTestDb());
    try {
      const row = await db.get<{ ok: number }>('SELECT 1 AS ok');
      expect(row).toEqual({ ok: 1 });
      // The singleton is untouched by the independent Db.
      const sharedRow = await shared.get<{ ok: number }>('SELECT 1 AS ok');
      expect(sharedRow).toEqual({ ok: 1 });
    } finally {
      await cleanup();
    }
  }, 15000);

  it('closes an independently built Db without disturbing the singleton', async () => {
    await initTestDb();
    const shared = await connectDb();

    const pool = createPgPool(process.env.TEST_DATABASE_URL!);
    const independent = new PgDb(pool, true);
    await independent.get('SELECT 1');
    await independent.close();

    // The shared pool must still work — closing one Db must not end the
    // other's pool (that was the whole point of the old factory injection:
    // each consumer got its own handle).
    const row = await shared.get<{ ok: number }>('SELECT 1 AS ok');
    expect(row).toEqual({ ok: 1 });
  });
});
