import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { connectDb, closeDb } from '../../db/index.js';
import { createPgPool, PgDb } from '../../db/pg.js';
import { createBackup } from '../../services/backups.js';
import { initTestDb } from '../helpers/test-db.js';

// The SQLite version of this file asserted three things that only exist for a
// SQLite database file:
//
//   * `pragma('busy_timeout')` — a file-level lock timeout;
//   * `pragma('foreign_keys')` and `pragma('journal_mode') = wal`;
//   * the mode of the database FILE and its -wal/-shm sidecars.
//
// PostgreSQL has no database file, no busy_timeout pragma and no WAL
// sidecars, so none of those can be asserted here. The guarantees behind them
// still have to hold, and each has a PostgreSQL form:
//
//   * concurrent writers must WAIT for the lock instead of erroring
//     -> lock_timeout is unset, so a blocked writer blocks;
//   * foreign keys must be enforced
//     -> the schema declares FK constraints and a violating insert is rejected;
//   * writes must be durable
//     -> fsync / synchronous_commit are on;
//   * the data must not be readable by other local accounts
//     -> the surviving artifact that holds data on disk is the backup dump,
//        and it is written owner-only (0600).

const ORIGINAL_DATA_DIR = process.env.FREEAPI_DATA_DIR;

afterEach(async () => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.FREEAPI_DATA_DIR;
  else process.env.FREEAPI_DATA_DIR = ORIGINAL_DATA_DIR;
  await closeDb().catch(() => { /* not connected */ });
});

describe('database runtime hardening (PG)', () => {
  it('makes a concurrent writer wait for the lock instead of failing', async () => {
    await initTestDb();
    const db = await connectDb();
    await db.run('CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER PRIMARY KEY, v INTEGER)');
    await db.run('INSERT INTO lock_probe (id, v) VALUES (1, 0)');

    // A second, independent pool over the SAME database: a separate session,
    // so the two statements really contend for the row lock.
    const other = new PgDb(createPgPool(process.env.DATABASE_URL!), true);
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });

      // Writer A takes the row lock and holds it until we open the gate.
      const writerA = db.transaction(async (tx) => {
        await tx.run('UPDATE lock_probe SET v = 1 WHERE id = 1');
        await gate;
        await tx.run('UPDATE lock_probe SET v = 2 WHERE id = 1');
      });

      // Writer B must block on the lock rather than raise "could not obtain
      // lock" — the PostgreSQL equivalent of SQLite's busy_timeout.
      let settled = false;
      let failed: unknown = null;
      const writerB = other
        .run('UPDATE lock_probe SET v = 3 WHERE id = 1')
        .then(() => { settled = true; })
        .catch((err) => { failed = err; settled = true; });

      await new Promise((r) => setTimeout(r, 300));
      expect(failed).toBeNull();
      expect(settled).toBe(false); // still waiting for A's lock

      release!();
      await writerA;
      await writerB;
      expect(failed).toBeNull();

      const row = await db.get<{ v: number }>('SELECT v FROM lock_probe WHERE id = 1');
      expect(row?.v).toBe(3);
    } finally {
      await other.close();
    }
  });

  it('enforces foreign keys', async () => {
    await initTestDb();
    const db = await connectDb();

    // The schema really declares foreign keys...
    const fks = await db.get<{ n: number }>(`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace
    `);
    expect(fks?.n).toBeGreaterThan(0);

    // ...and the database refuses a row that would violate one.
    await expect(
      db.run('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (999999999, 1, 1)'),
    ).rejects.toThrow(/foreign key/i);
  });

  it('keeps writes durable', async () => {
    await initTestDb();
    const db = await connectDb();

    const fsync = await db.get<{ fsync: string }>('SHOW fsync');
    expect(fsync?.fsync).toBe('on');

    const sync = await db.get<{ synchronous_commit: string }>('SHOW synchronous_commit');
    expect(['on', 'remote_apply', 'remote_write']).toContain(sync?.synchronous_commit);
  });

  it('writes backup dumps owner-only', async () => {
    // The data directory holds the dumps; point it at a scratch directory so
    // the test never writes into the repository.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-hardening-'));
    process.env.FREEAPI_DATA_DIR = dir;
    try {
      await initTestDb();
      const db = await connectDb();

      const meta = await createBackup(db, { tables: ['models'] });
      const row = await db.get<{ filepath: string }>(
        'SELECT filepath FROM backups WHERE id = ?',
        [meta.id],
      );
      expect(row?.filepath).toBeTruthy();

      const mode = fs.statSync(row!.filepath).mode & 0o777;
      // No access for group or other — the dump holds encrypted provider keys
      // and request history, so only the owner may read it.
      expect(mode & 0o077).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
