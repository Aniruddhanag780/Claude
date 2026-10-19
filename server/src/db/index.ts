import crypto from 'crypto';
import pg from 'pg';
import { getPostgresPool, initPostgresPool, closePostgresPool, type QueryResult } from './postgres.js';
import { runMigrations } from './migrate/runner.js';
import { initEncryptionKey, isEncryptionKeyInitialized } from '../lib/crypto.js';

let cachedUnifiedApiKey: string | null = null;
const settingsCache = new Map<string, string>();

export { getPostgresPool, initPostgresPool, closePostgresPool };

export function initDb(connectionString?: string): Promise<pg.Pool> & pg.Pool {
  const pool = initPostgresPool(connectionString);
  settingsCache.clear();
  cachedUnifiedApiKey = null;

  const promise = (async () => {
    // Run migrations automatically
    try {
      await runMigrations(pool, 'up');
      console.log('[db] PostgreSQL migrations applied successfully');

      if (!isEncryptionKeyInitialized()) {
        initEncryptionKey();
      }

      // Load all settings into in-memory cache for zero-DB reads in request path
      await loadSettingsCache(pool);

      // Ensure default unified API key exists
      await ensureUnifiedApiKey();
    } catch (err: any) {
      if (err?.message === 'Database is closed') {
        return pool;
      }
      console.error('[db] Error running PostgreSQL migrations:', err?.message ?? err);
      throw err;
    }

    return pool;
  })();

  const hybrid = new Proxy(promise, {
    get(target, prop, receiver) {
      if (prop in target) {
        const val = Reflect.get(target, prop, receiver);
        return typeof val === 'function' ? val.bind(target) : val;
      }
      const val = Reflect.get(pool, prop, pool);
      return typeof val === 'function' ? val.bind(pool) : val;
    }
  });

  return hybrid as any;
}

export function getDb(): pg.Pool & any {
  return getPostgresPool() as any;
}

export async function query<T extends pg.QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
  const pool = getPostgresPool();
  return pool.query<T>(text, params);
}

/**
 * Run a callback inside a BEGIN/COMMIT transaction with ROLLBACK on error.
 * Works on the real pool (pg) and on the in-memory mock pool alike, since both
 * honour BEGIN/COMMIT/ROLLBACK through `client.query`.
 */
export async function transaction<T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const pool = getPostgresPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function getDefaultDbPath(): string {
  return process.env.DATABASE_URL || 'neon-postgresql';
}

async function loadSettingsCache(pool: pg.Pool): Promise<void> {
  try {
    const res = await pool.query('SELECT key, value FROM settings');
    for (const row of res.rows) {
      if (row.key && row.value !== undefined && row.value !== null) {
        settingsCache.set(row.key, row.value);
      }
    }
    if (settingsCache.has('unified_api_key')) {
      cachedUnifiedApiKey = settingsCache.get('unified_api_key')!;
    }
  } catch (err: any) {
    console.warn('[db] Failed to preload settings cache:', err?.message ?? err);
  }
}

export function getUnifiedApiKey(): string {
  if (cachedUnifiedApiKey) {
    return cachedUnifiedApiKey;
  }
  const fromCache = settingsCache.get('unified_api_key');
  if (fromCache) {
    cachedUnifiedApiKey = fromCache;
    return fromCache;
  }
  const defaultKey = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  cachedUnifiedApiKey = defaultKey;
  settingsCache.set('unified_api_key', defaultKey);
  try {
    const pool = getPostgresPool() as any;
    pool.prepare?.("INSERT INTO settings (key, value) VALUES ('unified_api_key', ?) ON CONFLICT (key) DO NOTHING")?.run(defaultKey);
  } catch {}
  return defaultKey;
}

export function getCachedUnifiedApiKey(): string | null {
  return cachedUnifiedApiKey ?? settingsCache.get('unified_api_key') ?? getUnifiedApiKey();
}

export async function regenerateUnifiedKey(): Promise<string> {
  const pool = getPostgresPool();
  const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('unified_api_key', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key]
  );
  cachedUnifiedApiKey = key;
  settingsCache.set('unified_api_key', key);
  return key;
}

// The one intentional credential disclosure (restored from the deleted
// SQLite-era legacy baseline): a freshly generated unified key is written
// straight to stdout, bypassing the console redaction installed in index.ts —
// the operator must be able to copy it once. Any other environment
// (production, non-TTY, Kubernetes, CI) only receives a pointer message so the
// key can never land in a captured log or CI transcript.
function discloseUnifiedKey(key: string): void {
  const dev = process.env.NODE_ENV !== 'production';
  const kubernetes = process.env.KUBERNETES_SERVICE_HOST != null;
  const ci = process.env.CI != null && process.env.CI !== '';
  if (dev && !kubernetes && !ci && process.stdout.isTTY) {
    process.stdout.write(`\n  Your unified API key: ${key}\n\n`);
    return;
  }
  console.log('New unified API key created. View it in the dashboard under the Keys page; it is not printed to logs.');
}

async function ensureUnifiedApiKey(): Promise<void> {
  const pool = getPostgresPool();
  const res = await pool.query("SELECT value FROM settings WHERE key = 'unified_api_key'");
  if (res.rows.length === 0 || !res.rows[0].value) {
    const key = cachedUnifiedApiKey || `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('unified_api_key', $1, NOW())
       ON CONFLICT (key) DO NOTHING`,
      [key]
    );
    cachedUnifiedApiKey = key;
    settingsCache.set('unified_api_key', key);
    discloseUnifiedKey(key);
  } else {
    cachedUnifiedApiKey = res.rows[0].value;
    settingsCache.set('unified_api_key', res.rows[0].value);
  }
}

export function getSetting(key: string): string | undefined {
  try {
    const pool = getPostgresPool() as any;
    if (pool.prepare) {
      const row = pool.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined;
      if (row?.value !== undefined) {
        settingsCache.set(key, row.value);
        return row.value;
      } else {
        settingsCache.delete(key);
        return undefined;
      }
    }
  } catch {}
  return settingsCache.get(key);
}

export function deleteSetting(key: string): void {
  settingsCache.delete(key);
  try {
    const pool = getPostgresPool() as any;
    pool.prepare?.('DELETE FROM settings WHERE key = ?')?.run(key);
  } catch {}
}

export async function getSettingAsync(key: string): Promise<string | undefined> {
  if (settingsCache.has(key)) {
    return settingsCache.get(key);
  }
  const pool = getPostgresPool();
  const res = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  if (res.rows[0]?.value !== undefined) {
    settingsCache.set(key, res.rows[0].value);
    return res.rows[0].value;
  }
  return undefined;
}

export async function setSetting(key: string, value: string): Promise<void> {
  settingsCache.set(key, value);
  const pool = getPostgresPool();
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
}
