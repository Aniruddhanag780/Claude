import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';

afterEach(() => {
  vi.restoreAllMocks();
});

// The old SQLite initDb(path, { ensureDir }) option (create the parent
// directory of a database FILE) is gone: Postgres has no database file, so
// there is no directory to ensure. What must hold on PG instead is the
// connection-resolution contract: an explicit connection string wins, a
// missing one fails loudly (never a silent fallback), and initDb never
// touches the filesystem.
describe('initDb connection resolution (PG)', () => {
  it('accepts an explicit connection string and never touches the filesystem', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);

    const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
    const openSpy = vi.spyOn(fs, 'openSync');

    vi.resetModules();
    const { initDb, closeDb } = await import('../../db/index.js');

    const url = process.env.TEST_DATABASE_URL;
    expect(url).toBeTruthy();
    const db = await initDb(url);

    const row = (await db.get('SELECT 1 AS ok'));
    expect(row).toEqual({ ok: 1 });
    await closeDb();

    expect(mkdirSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('fails loudly when no connection string is configured', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);

    const saved = {
      DATABASE_URL: process.env.DATABASE_URL,
      POSTGRES_URL: process.env.POSTGRES_URL,
      PG_DATABASE_URL: process.env.PG_DATABASE_URL,
    };
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;
    delete process.env.PG_DATABASE_URL;

    vi.resetModules();
    const { initDb, closeDb } = await import('../../db/index.js');

    try {
      await expect(initDb()).rejects.toThrow(/DATABASE_URL/);
    } finally {
      if (saved.DATABASE_URL !== undefined) process.env.DATABASE_URL = saved.DATABASE_URL;
      if (saved.POSTGRES_URL !== undefined) process.env.POSTGRES_URL = saved.POSTGRES_URL;
      if (saved.PG_DATABASE_URL !== undefined) process.env.PG_DATABASE_URL = saved.PG_DATABASE_URL;
      await closeDb();
    }
  });
});
