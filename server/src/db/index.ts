import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import { runMigrations } from './migrate/runner.js';
import { initEncryptionKey, isEncryptionKeyInitialized } from '../lib/crypto.js';
import { createPgPool, PgDb } from './pg.js';
import type { Db } from './types.js';

export type { Db, QueryResult, RunResult } from './types.js';

let db: Db | null = null;

export function getDb(): Db {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() or connectDb() first.');
  }
  return db;
}

/**
 * Resolve the Postgres connection string. There is no SQLite fallback: a
 * missing DATABASE_URL is a configuration error that must surface loudly
 * (Section 8 — never silently fall back to an ephemeral local database).
 */
function resolveDatabaseUrl(): string {
  const url = (
    process.env.DATABASE_URL ??
    process.env.POSTGRES_URL ??
    process.env.PG_DATABASE_URL ??
    ''
  ).trim();

  if (!url) {
    const isProd = process.env.NODE_ENV === 'production';
    const hint =
      '  Set DATABASE_URL to your PostgreSQL connection string, e.g.\n' +
      '    postgresql://user:password@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require\n';
    throw new Error(
      (isProd
        ? 'DATABASE_URL is required in production but was not set; refusing to start without a real database.\n'
        : 'DATABASE_URL is not set; the server requires a PostgreSQL database (no SQLite fallback).\n') + hint,
    );
  }
  return url;
}

/**
 * Open the shared pool (without running migrations). Prefer {@link initDb} for
 * application startup; this exists for the migration CLI and tests that manage
 * migrations themselves.
 */
export async function connectDb(connectionString?: string): Promise<Db> {
  if (db) return db;
  const url = connectionString ?? resolveDatabaseUrl();
  const pool = createPgPool(url);
  db = new PgDb(pool, /* ownsExecutor */ true);
  console.log(`[db] connected (pool max=${process.env.PG_MAX_CONNECTIONS || 10})`);
  return db;
}

/**
 * Connect, run pending migrations, and ensure the encryption key exists.
 * This is the normal application startup path.
 */
export async function initDb(connectionString?: string): Promise<Db> {
  const conn = await connectDb(connectionString);

  if (process.env.NODE_ENV !== 'development') {
    await runMigrations(conn, 'up');
  } else {
    // In dev, verify the schema has been initialised. If not, give a clear error.
    const ready = await conn.get<{ relname: string }>(
      "SELECT to_regclass('migrations') AS relname",
    );
    if (!ready?.relname) {
      console.error(
        '\n  [dev] Database not initialised. Run:\n\n' +
          '    npm run db:migration:up\n\n' +
          '  Then restart the server.\n',
      );
      process.exit(1);
    }
  }

  if (!isEncryptionKeyInitialized()) await initEncryptionKey(conn);

  return conn;
}

/**
 * Local directory for files this app owns (SQL dumps, export artifacts).
 *
 * Postgres has no database file to sit next to, so the data directory is a
 * plain local path. It is NOT durable storage - it lives on the host's
 * ephemeral disk and is wiped on every deploy - which is exactly why the
 * application records themselves live in Postgres.
 */
export function getDataDir(): string {
  const configured = process.env.FREEAPI_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
}

/** Close the shared pool. Safe to call when nothing is connected. */
export async function closeDb(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
    console.log('[db] pool closed');
  }
}

// --- Unified API key ---

export async function getUnifiedApiKey(): Promise<string> {
  const row = await getDb().get<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'unified_api_key'",
  );
  if (!row) throw new Error("settings row 'unified_api_key' is missing");
  return row.value;
}

export async function regenerateUnifiedKey(): Promise<string> {
  const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  await getDb().run(
    "UPDATE settings SET value = ? WHERE key = 'unified_api_key'",
    [key],
  );
  return key;
}

// --- Generic key/value settings accessors (used by routing strategy, etc.). ---

export async function getSetting(key: string): Promise<string | undefined> {
  const row = await getDb().get<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    [key],
  );
  return row?.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await getDb().run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}
