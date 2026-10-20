import { describe, expect, it } from 'vitest';
import { getPostgresPool } from '../../../db/postgres.js';
import { getMigrationStatuses, runMigrations } from '../../../db/migrate/runner.js';
import {
  INITIAL_SCHEMA_FILENAME,
  SEED_PROVIDERS_MODELS_FILENAME,
  ADD_HEALTH_COLUMNS_FILENAME,
  FIX_SETTINGS_UPDATED_AT_FILENAME,
  ADD_MISSING_MODEL_COLUMNS_FILENAME,
  COMPAT_TABLES_FILENAME,
  SEARCH_AND_ENDPOINT_GROUP_FILENAME,
  LEGACY_KEY_USAGE_FILENAME,
  SEED_FALLBACK_AND_DEFAULT_PROFILE_FILENAME,
  MODELS_PLATFORM_AND_SOURCE_FILENAME,
  ADD_PROXY_TO_CREDENTIALS_AND_API_KEYS_FILENAME,
  REQUEST_ATTEMPTS_AND_SERVED_MODEL_FILENAME,
  BENCHMARK_CATALOG_MODELS_FILENAME,
  DEFAULT_MIGRATIONS,
} from '../../../db/migrate/defaults.js';

describe('PostgreSQL migration runner', () => {
  it('runs all PostgreSQL migrations up, checks status, and verifies default schema', async () => {
    const pool = getPostgresPool();

    await runMigrations(pool, 'up');

    const statuses = await getMigrationStatuses(pool);
    expect(statuses.length).toBe(DEFAULT_MIGRATIONS.length);
    expect(statuses.every(s => s.status === 'applied')).toBe(true);

    expect(statuses.map(s => s.filename)).toEqual([
      INITIAL_SCHEMA_FILENAME,
      SEED_PROVIDERS_MODELS_FILENAME,
      ADD_HEALTH_COLUMNS_FILENAME,
      FIX_SETTINGS_UPDATED_AT_FILENAME,
      ADD_MISSING_MODEL_COLUMNS_FILENAME,
      COMPAT_TABLES_FILENAME,
      SEARCH_AND_ENDPOINT_GROUP_FILENAME,
      LEGACY_KEY_USAGE_FILENAME,
      SEED_FALLBACK_AND_DEFAULT_PROFILE_FILENAME,
      MODELS_PLATFORM_AND_SOURCE_FILENAME,
      ADD_PROXY_TO_CREDENTIALS_AND_API_KEYS_FILENAME,
      REQUEST_ATTEMPTS_AND_SERVED_MODEL_FILENAME,
      BENCHMARK_CATALOG_MODELS_FILENAME,
    ]);

    // Verify providers seeded
    const providersRes = await pool.query('SELECT COUNT(*) as c FROM providers');
    expect(Number(providersRes.rows[0]?.c ?? 0)).toBeGreaterThan(0);

    // The benchmark catalog models are seeded by 002 on a fresh database and
    // backfilled by 013 on an existing one; both paths must land the same rows.
    for (const id of [
      'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3-32b',
      'nousresearch/hermes-3-llama-3.1-405b:free', 'gemma-4-26b-a4b-it',
      'groq/compound-mini', 'groq/compound', 'gpt-4o',
    ]) {
      const found = await pool.query('SELECT id FROM models WHERE model_id = $1', [id]);
      expect(found.rows.length, `missing benchmark model ${id}`).toBeGreaterThan(0);
    }
  });
});
