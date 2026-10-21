import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../db/types.js';
import { runMigrations } from '../../../db/migrate/runner.js';
import { createEmptyTestDb } from '../../helpers/test-db.js';

// PG: the migration runner is exercised against EMPTY scratch databases (the
// old `new Database(':memory:')` equivalent). Generated fixture migrations are
// async PgDb-style, exactly like the real ones in src/db/migrations.

const tempDirs: string[] = [];
const LEGACY_BASELINE_FILENAME = '20260101_000000_legacy_baseline.ts';

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('migration runner', () => {
  it('runs pending migrations up and records applied files', async () => {
    const migrationsDir = createMigrationsDir();
    writeMigration(migrationsDir, '20260608_000001_create_widgets.ts', `
      export async function up(db: any): Promise<void> {
        await db.exec('CREATE TABLE IF NOT EXISTS widgets (id INTEGER PRIMARY KEY)');
      }

      export async function down(db: any): Promise<void> {
        await db.exec('DROP TABLE IF EXISTS widgets');
      }
    `);
    writeMigration(migrationsDir, '20260608_000002_create_gadgets.ts', `
      export async function up(db: any): Promise<void> {
        await db.exec('CREATE TABLE IF NOT EXISTS gadgets (id INTEGER PRIMARY KEY)');
      }

      export async function down(db: any): Promise<void> {
        await db.exec('DROP TABLE IF EXISTS gadgets');
      }
    `);

    const { db, cleanup } = await createEmptyTestDb();
    try {
      await runMigrations(db, 'up', { migrationsDir });

      const applied = await db.all('SELECT filename FROM migrations ORDER BY filename ASC') as { filename: string }[];
      expect(applied.map(row => row.filename)).toEqual([
        '20260608_000001_create_widgets.ts',
        '20260608_000002_create_gadgets.ts',
      ]);
      expect(await hasTable(db, 'widgets')).toBe(true);
      expect(await hasTable(db, 'gadgets')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('runs one down migration and removes its migrations row', async () => {
    const migrationsDir = createMigrationsDir();
    writeMigration(migrationsDir, '20260608_000001_create_widgets.ts', `
      export async function up(db: any): Promise<void> {
        await db.exec('CREATE TABLE IF NOT EXISTS widgets (id INTEGER PRIMARY KEY)');
      }

      export async function down(db: any): Promise<void> {
        await db.exec('DROP TABLE IF EXISTS widgets');
      }
    `);
    writeMigration(migrationsDir, '20260608_000002_create_gadgets.ts', `
      export async function up(db: any): Promise<void> {
        await db.exec('CREATE TABLE IF NOT EXISTS gadgets (id INTEGER PRIMARY KEY)');
      }

      export async function down(db: any): Promise<void> {
        await db.exec('DROP TABLE IF EXISTS gadgets');
      }
    `);

    const { db, cleanup } = await createEmptyTestDb();
    try {
      await runMigrations(db, 'up', { migrationsDir });
      await runMigrations(db, 'down', { migrationsDir });

      const applied = await db.all('SELECT filename FROM migrations ORDER BY filename ASC') as { filename: string }[];
      expect(applied.map(row => row.filename)).toEqual(['20260608_000001_create_widgets.ts']);
      expect(await hasTable(db, 'widgets')).toBe(true);
      expect(await hasTable(db, 'gadgets')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('skips already-applied migrations on later up runs', async () => {
    const migrationsDir = createMigrationsDir();
    writeMigration(migrationsDir, '20260608_000001_insert_counter.ts', `
      export async function up(db: any): Promise<void> {
        await db.exec('CREATE TABLE IF NOT EXISTS run_counter (value INTEGER NOT NULL)');
        await db.run('INSERT INTO run_counter (value) VALUES (1)');
      }

      export async function down(db: any): Promise<void> {
        await db.exec('DROP TABLE IF EXISTS run_counter');
      }
    `);

    const { db, cleanup } = await createEmptyTestDb();
    try {
      await runMigrations(db, 'up', { migrationsDir });
      await runMigrations(db, 'up', { migrationsDir });

      const runs = await db.get('SELECT COUNT(*) AS count FROM run_counter') as { count: number };
      const applied = await db.get('SELECT COUNT(*) AS count FROM migrations') as { count: number };
      expect(runs.count).toBe(1);
      expect(applied.count).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('rolls back a failing up migration and does not record it', async () => {
    const migrationsDir = createMigrationsDir();
    writeMigration(migrationsDir, '20260608_000001_fails.ts', `
      export async function up(db: any): Promise<void> {
        await db.exec('CREATE TABLE failed_table (id INTEGER PRIMARY KEY)');
        throw new Error('boom');
      }

      export async function down(db: any): Promise<void> {
        await db.exec('DROP TABLE IF EXISTS failed_table');
      }
    `);

    const { db, cleanup } = await createEmptyTestDb();
    try {
      await expect(runMigrations(db, 'up', { migrationsDir })).rejects.toThrow('boom');

      const applied = await db.get('SELECT COUNT(*) AS count FROM migrations') as { count: number };
      expect(applied.count).toBe(0);
      expect(await hasTable(db, 'failed_table')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('runs the legacy baseline even when the legacy sentinel schema exists', async () => {
    const migrationsDir = createMigrationsDir();
    writeMigration(migrationsDir, LEGACY_BASELINE_FILENAME, `
      export async function up(db: any): Promise<void> {
        await db.exec('CREATE TABLE IF NOT EXISTS baseline_ran (id INTEGER PRIMARY KEY)');
      }

      export async function down(_db: any): Promise<void> {
        throw new Error('baseline is irreversible');
      }
    `);
    writeMigration(migrationsDir, '20260608_000001_after_baseline.ts', `
      export async function up(db: any): Promise<void> {
        await db.exec('CREATE TABLE IF NOT EXISTS after_baseline (id INTEGER PRIMARY KEY)');
      }

      export async function down(db: any): Promise<void> {
        await db.exec('DROP TABLE IF EXISTS after_baseline');
      }
    `);

    const { db, cleanup } = await createEmptyTestDb();
    try {
      await db.exec(`
        CREATE TABLE models (
          id INTEGER PRIMARY KEY,
          supports_tools INTEGER NOT NULL DEFAULT 0
        );
      `);

      await runMigrations(db, 'up', { migrationsDir });

      const applied = await db.all('SELECT filename FROM migrations ORDER BY id ASC') as { filename: string }[];
      expect(applied.map(row => row.filename)).toEqual([
        LEGACY_BASELINE_FILENAME,
        '20260608_000001_after_baseline.ts',
      ]);
      expect(await hasTable(db, 'baseline_ran')).toBe(true);
      expect(await hasTable(db, 'after_baseline')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('runs the legacy baseline normally for fresh DBs', async () => {
    const migrationsDir = createMigrationsDir();
    writeMigration(migrationsDir, LEGACY_BASELINE_FILENAME, `
      export async function up(db: any): Promise<void> {
        await db.exec('CREATE TABLE models (id INTEGER PRIMARY KEY, supports_tools INTEGER NOT NULL DEFAULT 0)');
      }

      export async function down(_db: any): Promise<void> {
        throw new Error('baseline is irreversible');
      }
    `);

    const { db, cleanup } = await createEmptyTestDb();
    try {
      await runMigrations(db, 'up', { migrationsDir });

      const applied = await db.all('SELECT filename FROM migrations ORDER BY id ASC') as { filename: string }[];
      expect(applied.map(row => row.filename)).toEqual([LEGACY_BASELINE_FILENAME]);
      expect(await hasTable(db, 'models')).toBe(true);
      expect(await hasColumn(db, 'models', 'supports_tools')).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

function createMigrationsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-migrations-'));
  tempDirs.push(dir);
  return dir;
}

function writeMigration(migrationsDir: string, filename: string, source: string): void {
  fs.writeFileSync(path.join(migrationsDir, filename), source.trimStart());
}

async function hasTable(db: Db, tableName: string): Promise<boolean> {
  const row = await db.get('SELECT to_regclass(?) AS reg', [tableName]) as { reg: string | null };
  return row.reg !== null;
}

async function hasColumn(db: Db, tableName: string, columnName: string): Promise<boolean> {
  const columns = await db.all(
    'SELECT column_name FROM information_schema.columns WHERE table_name = ?',
    [tableName],
  ) as { column_name: string }[];
  return columns.some(column => column.column_name === columnName);
}
