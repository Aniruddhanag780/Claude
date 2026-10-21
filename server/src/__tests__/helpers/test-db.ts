// Shared PostgreSQL test harness — the replacement for upstream's
// `initDb(':memory:')` (one fresh synchronous SQLite per test file).
//
// Each initTestDb() call gives the calling test file its own database:
//
//   1. the first call in a process builds a template database
//      (`fm_test_tpl_<pid>`) by running the real migrations once;
//   2. every call then clones the template with `CREATE DATABASE ...
//      TEMPLATE`, a server-side file copy of the fully migrated + seeded
//      schema (~100ms), so every file starts from identical, isolated state;
//   3. the clone is opened through the production `connectDb` pool, so tests
//      exercise the real connection/pool/SQL path — not a mock or shim;
//   4. an afterAll hook drops the clone again, so nothing leaks between
//      files, processes, or runs.
//
// Requires TEST_DATABASE_URL or DATABASE_URL to point at a SCRATCH
// PostgreSQL database (e.g. the docker `postgres:16-alpine` used in CI).
// Never point it at production data: every initTestDb() creates and drops
// databases named `fm_test_*`.
import { afterAll } from 'vitest';
import { Client } from 'pg';

import type { Db } from '../../db/types.js';

const PREFIX = 'fm_test_';

let template: Promise<string> | null = null;
let counter = 0;

function baseUrl(): string {
  const url = (process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '').trim();
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL/DATABASE_URL must point at a scratch PostgreSQL database to run these tests',
    );
  }
  return url;
}

function urlFor(dbName: string): string {
  const u = new URL(baseUrl());
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function withAdmin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const u = new URL(baseUrl());
  u.pathname = '/postgres'; // maintenance database — never one under test
  const c = new Client({ connectionString: u.toString() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** DROP DATABASE, first terminating any backend still attached to it. Without
 *  this the drop blocks until PG reaps the connection itself, which times out
 *  tests whose pool teardown races the drop (seen in migrate/runner.test.ts). */
async function dropDatabase(name: string): Promise<void> {
  await withAdmin(async (c) => {
    await c.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [name],
    );
    await c.query(`DROP DATABASE IF EXISTS ${name}`);
  });
}

async function createFromTemplate(name: string, tpl: string): Promise<void> {
  // CREATE DATABASE ... TEMPLATE fails while any session is connected to the
  // template; a short retry covers lingering pool teardown.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await withAdmin(async (c) => {
        await c.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [name],
        );
        await c.query(`DROP DATABASE IF EXISTS ${name}`);
        await c.query(`CREATE DATABASE ${name} TEMPLATE ${tpl}`);
      });
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastErr;
}

async function buildTemplate(name: string): Promise<string> {
  const { connectDb, closeDb } = await import('../../db/index.js');
  const { runMigrations } = await import('../../db/migrate/runner.js');
  await dropDatabase(name);
  await withAdmin((c) => c.query(`CREATE DATABASE ${name}`));
  const db = await connectDb(urlFor(name));
  try {
    await runMigrations(db, 'up');
  } finally {
    await closeDb();
  }
  return name;
}

/**
 * Connect the app's shared pool to a fresh, fully migrated database that only
 * this test file sees. Call it from `beforeAll`, exactly where upstream tests
 * called `initDb(':memory:')`.
 */
export async function initTestDb(): Promise<Db> {
  const { connectDb, closeDb } = await import('../../db/index.js');
  const { initEncryptionKey } = await import('../../lib/crypto.js');

  // pg's connect/idle timers are setTimeout-based: under test files that use
  // fake timers they would fire instantly on any fake-time advance and kill
  // live connections mid-query. Disable them for the whole test process.
  process.env.PG_IDLE_TIMEOUT_MS = '0';
  process.env.PG_CONNECT_TIMEOUT_MS = '0';

  if (!template) template = buildTemplate(`${PREFIX}tpl_${process.pid}`);
  const tpl = await template;

  // A previous file in this process may still hold its pool.
  try {
    await closeDb();
  } catch {
    /* not connected */
  }

  const name = `${PREFIX}${process.pid}_${++counter}`;
  await createFromTemplate(name, tpl);

  const cloneUrl = urlFor(name);
  // Anything that resolves the connection string from the environment —
  // spawned child processes (CLIs under test), connectDb() with no argument —
  // must land on THIS file's database, never the shared base one.
  process.env.DATABASE_URL = cloneUrl;

  const db = await connectDb(cloneUrl);
  await initEncryptionKey(db);

  afterAll(async () => {
    try {
      await closeDb();
    } catch {
      /* already closed */
    }
    await dropDatabase(name).catch(() => {
      /* best effort — global-setup reaps leftovers */
    });
  });

  return db;
}


let scratchCounter = 0;

/**
 * An EMPTY scratch database with no migrations applied — the PG stand-in for
 * the throwaway `new Database(':memory:')` that migration tests used to build.
 * Owns its own pool (the process-global singleton is untouched); call
 * `cleanup()` when done. global-setup reaps `fm_test_*` leftovers after a crash.
 */
export async function createEmptyTestDb(): Promise<{ db: Db; url: string; cleanup: () => Promise<void> }> {
  const name = `${PREFIX}emp_${process.pid}_${++scratchCounter}`;
  await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${name}`));
  await withAdmin((c) => c.query(`CREATE DATABASE ${name}`));
  const url = urlFor(name);
  const { createPgPool, PgDb } = await import('../../db/pg.js');
  const db = new PgDb(createPgPool(url), true);
  return {
    db,
    url,
    cleanup: async () => {
      try { await db.close(); } catch { /* already closed */ }
      await dropDatabase(name).catch(() => {
        /* best effort — global-setup reaps leftovers */
      });
    },
  };
}
