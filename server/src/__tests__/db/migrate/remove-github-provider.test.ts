import { describe, expect, it } from 'vitest';
import type { Db } from '../../../db/types.js';
import { runMigrations } from '../../../db/migrate/runner.js';
import { up, down } from '../../../db/migrations/20261017_000002_remove_github_provider.js';
import { createEmptyTestDb } from '../../helpers/test-db.js';

// GitHub Models was retired upstream (#549); leftover keys looked healthy and
// custom GitHub models still joined the chain (#1557).

async function migratedDb(): Promise<Db> {
  const { db } = await createEmptyTestDb();
  await runMigrations(db, 'up');
  return db;
}

async function githubCounts(db: Db) {
  const count = async (sql: string) => (await db.get(sql) as { n: number }).n;
  return {
    keys: await count("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'github'"),
    models: await count("SELECT COUNT(*) AS n FROM models WHERE platform = 'github'"),
    chain: await count("SELECT COUNT(*) AS n FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'github')"),
  };
}

describe('remove_github_provider migration (#1557)', () => {
  it('removes a leftover GitHub key and custom model, keeps other providers, and DOWN restores them', async () => {
    const db = await migratedDb();
    // The state a user upgrading from 0.15.0 has: a GitHub key and a custom
    // GitHub model in the fallback chain.
    const keyId = Number((await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('github', 'gh', 'enc', 'iv', 'tag', 'healthy', 1)
      RETURNING id
    `)).lastInsertRowid);
    const modelId = Number((await db.run(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source)
      VALUES ('github', 'openai/gpt-4.1', 'GPT-4.1', 20, 7, 1, 'user')
      RETURNING id
    `)).lastInsertRowid);
    await db.run('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 999, 1)', [modelId]);
    await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'groq', 'enc', 'iv', 'tag', 'healthy', 1)
    `);
    const otherModels = (await db.get("SELECT COUNT(*) AS n FROM models WHERE platform != 'github'") as { n: number }).n;

    await up(db);
    expect(await githubCounts(db)).toEqual({ keys: 0, models: 0, chain: 0 });
    expect(await db.get("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'groq'")).toEqual({ n: 1 });
    expect((await db.get("SELECT COUNT(*) AS n FROM models WHERE platform != 'github'") as { n: number }).n).toBe(otherModels);
    const orphans = await db.get('SELECT COUNT(*) AS n FROM fallback_config f LEFT JOIN models m ON f.model_db_id = m.id WHERE m.id IS NULL') as { n: number };
    expect(orphans.n).toBe(0);

    await down(db);
    expect(await githubCounts(db)).toEqual({ keys: 1, models: 1, chain: 1 });
    expect(await db.get('SELECT id, status, enabled FROM api_keys WHERE platform = ?', ['github']))
      .toEqual({ id: keyId, status: 'healthy', enabled: 1 });
    expect(await db.get("SELECT value FROM settings WHERE key = 'migration_github_removed_rows'")).toBeUndefined();
  });
});
