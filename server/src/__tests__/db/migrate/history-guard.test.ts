import { afterEach, describe, expect, it } from 'vitest';
import { closePostgresPool, initPostgresPool } from '../../../db/postgres.js';
import {
  assertMigrationHistoryCompatible,
  getMigrationStatuses,
  runMigrations,
} from '../../../db/migrate/runner.js';
import { DEFAULT_MIGRATIONS } from '../../../db/migrate/defaults.js';

// One of the orphan SQLite-format migrations deleted in G4: a real production
// ledger may still record it while the file no longer exists.
const PHANTOM = '20260930_000001_custom_endpoint_group_label.ts';
const REGISTERED = DEFAULT_MIGRATIONS.map(m => m.filename);

async function recordAsApplied(pool: any, ...filenames: string[]): Promise<void> {
  for (const filename of filenames) {
    await pool.query('INSERT INTO migrations (filename) VALUES ($1)', [filename]);
  }
}

async function ledgerFilenames(pool: any): Promise<string[]> {
  const rows = await pool.query('SELECT filename FROM migrations ORDER BY filename');
  return rows.rows.map((row: any) => row.filename);
}

describe('migration history guard', () => {
  afterEach(async () => {
    await closePostgresPool();
  });

  it('passes when the ledger only contains registered migrations', async () => {
    const pool = initPostgresPool(':memory:');
    await recordAsApplied(pool, REGISTERED[0], REGISTERED[3]);
    await expect(assertMigrationHistoryCompatible(pool)).resolves.toBeUndefined();
  });

  it('fails when the ledger contains migrations with no matching file', async () => {
    const pool = initPostgresPool(':memory:');
    await recordAsApplied(pool, PHANTOM, REGISTERED[0]);

    let error: unknown;
    try {
      await assertMigrationHistoryCompatible(pool);
    } catch (err) {
      error = err;
    }
    expect(error).toBeDefined();
    expect(String(error)).toMatch(/Incompatible migration history/);
    expect(String(error)).toContain(PHANTOM);
    expect(String(error)).toContain('no corresponding migration file');
    expect(String(error)).toContain('manually');
    expect(String(error)).not.toContain('auto-rewrite');
  });

  it('runMigrations refuses to apply anything when history is incompatible', async () => {
    const pool = initPostgresPool(':memory:');
    await recordAsApplied(pool, PHANTOM);

    await expect(runMigrations(pool, 'up')).rejects.toThrow(/Incompatible migration history/);

    // Nothing was applied: the ledger still only holds the phantom entry.
    expect(await ledgerFilenames(pool)).toEqual([PHANTOM]);
  });

  it('runMigrations applies pending migrations when history is compatible', async () => {
    const pool = initPostgresPool(':memory:');
    await recordAsApplied(pool, REGISTERED[0]);

    await runMigrations(pool, 'up');

    const statuses = await getMigrationStatuses(pool);
    expect(statuses.every(s => s.status === 'applied')).toBe(true);
    expect(statuses.map(s => s.filename)).toEqual(REGISTERED);
  });

  it('getMigrationStatuses fails on incompatible history too', async () => {
    const pool = initPostgresPool(':memory:');
    await recordAsApplied(pool, PHANTOM);

    await expect(getMigrationStatuses(pool)).rejects.toThrow(/Incompatible migration history/);
  });
});
