import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closePostgresPool, initPostgresPool } from '../../db/postgres.js';
import { query } from '../../db/index.js';
import { runMigrations } from '../../db/migrate/runner.js';
import {
  listUrlTokens,
  mintUrlToken,
  revokeUrlToken,
  validateUrlToken,
} from '../../services/url-tokens.js';

const useRealPg = Boolean(process.env.USE_REAL_POSTGRES);

beforeEach(async () => {
  const pool = initPostgresPool(':memory:');
  if (useRealPg) await runMigrations(pool, 'up');
  await query('DELETE FROM url_tokens');
});

afterEach(async () => {
  await closePostgresPool();
});

describe('url-tokens (service, mock pool)', () => {
  it('mints, lists, validates, and revokes a token', async () => {
    const minted = await mintUrlToken('VS Code');
    expect(minted.token).toMatch(/^flmurl_/);
    expect(minted.label).toBe('VS Code');
    expect(typeof minted.id).toBe('number');
    expect(minted.createdAt).toBeDefined();
    expect(minted.lastUsedAt).toBeFalsy(); // SQL NULL under Postgres, undefined under the mock
    expect(minted.revokedAt).toBeFalsy();

    const tokens = await listUrlTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].id).toBe(minted.id);
    expect(tokens[0].label).toBe('VS Code');
    expect(tokens[0].tokenPrefix).toBe(`${minted.token.slice(0, 12)}…`);

    expect(await validateUrlToken(minted.token)).toBe(true);

    // read-after-write: validation records last_used_at
    const used = await listUrlTokens();
    expect(used[0].lastUsedAt).toBeDefined();

    // a tampered token is rejected
    expect(await validateUrlToken(minted.token + 'x')).toBe(false);

    expect(await revokeUrlToken(minted.id)).toBe(true);
    expect(await validateUrlToken(minted.token)).toBe(false);

    // revoking an already-revoked token reports no change
    expect(await revokeUrlToken(minted.id)).toBe(false);
  });

  it('validates nothing and lists nothing on an empty table', async () => {
    expect(await validateUrlToken('flmurl_' + 'x'.repeat(43))).toBe(false);
    expect(await listUrlTokens()).toEqual([]);
  });
});

describe.skipIf(!process.env.USE_REAL_POSTGRES)(
  'url-tokens (real Postgres durability)',
  () => {
    beforeEach(async () => {
      const pool = initPostgresPool(':memory:');
      await runMigrations(pool, 'up');
      await closePostgresPool();
    });

    afterEach(async () => {
      await closePostgresPool();
    });

    it('persists a minted token and invalidates it on revoke', async () => {
      const pool = initPostgresPool(':memory:');

      const before = Number(
        (await pool.query('SELECT COUNT(*) AS c FROM url_tokens')).rows[0]?.c ?? 0,
      );

      const minted = await mintUrlToken('durability');

      const after = Number(
        (await pool.query('SELECT COUNT(*) AS c FROM url_tokens')).rows[0]?.c ?? 0,
      );
      expect(after).toBe(before + 1);

      const found = await pool.query(
        'SELECT last_used_at FROM url_tokens WHERE token_prefix = $1',
        [minted.tokenPrefix],
      );
      expect(found.rows).toHaveLength(1);
      expect(found.rows[0].last_used_at).toBeNull();

      // two statements, read-after-write: SELECT then UPDATE last_used_at
      expect(await validateUrlToken(minted.token)).toBe(true);
      const used = await pool.query(
        'SELECT last_used_at FROM url_tokens WHERE token_prefix = $1',
        [minted.tokenPrefix],
      );
      expect(used.rows[0].last_used_at).not.toBeNull();

      expect(await validateUrlToken(minted.token + 'x')).toBe(false);
      expect(await revokeUrlToken(minted.id)).toBe(true);
      expect(await validateUrlToken(minted.token)).toBe(false);
    });
  },
);
