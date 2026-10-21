import { describe, expect, it } from 'vitest';
import type { Db } from '../../../db/types.js';
import { runMigrations } from '../../../db/migrate/runner.js';
import { up, down } from '../../../db/migrations/20261019_000001_remove_auray_provider.js';
import { createEmptyTestDb } from '../../helpers/test-db.js';

// Auray started charging for API access and asked to be removed (#1583).

async function migratedDb(): Promise<Db> {
  const { db } = await createEmptyTestDb();
  await runMigrations(db, 'up');
  return db;
}

async function aurayCounts(db: Db) {
  const count = async (sql: string) => (await db.get(sql) as { n: number }).n;
  return {
    keys: await count("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'auray'"),
    models: await count("SELECT COUNT(*) AS n FROM models WHERE platform = 'auray'"),
    embeddings: await count("SELECT COUNT(*) AS n FROM embedding_models WHERE platform = 'auray'"),
    chain: await count("SELECT COUNT(*) AS n FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'auray')"),
  };
}

describe('remove_auray_provider migration (#1583)', () => {
  it('removes Auray keys, models, embeddings and chain rows, keeps other providers, and DOWN restores them', async () => {
    const db = await migratedDb();
    // The state a Premium user upgrading from 0.16.3 has: an Auray key, its
    // catalog models in the chain, and the Auray embedding row.
    const keyId = Number((await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('auray', 'auray', 'enc', 'iv', 'tag', 'healthy', 1)
      RETURNING id
    `)).lastInsertRowid);
    const modelId = Number((await db.run(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source)
      VALUES ('auray', 'kimi-k3', 'Kimi K3', 20, 7, 1, 'catalog')
      RETURNING id
    `)).lastInsertRowid);
    await db.run('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 999, 1)', [modelId]);
    await db.run(`
      INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, enabled)
      VALUES ('qwen3-embedding-8b', 'auray', 'qwen3-embedding-8b', 'Qwen3 Embedding 8B', 4096, 1)
    `);
    await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'groq', 'enc', 'iv', 'tag', 'healthy', 1)
    `);
    const otherModels = (await db.get("SELECT COUNT(*) AS n FROM models WHERE platform != 'auray'") as { n: number }).n;

    await up(db);
    expect(await aurayCounts(db)).toEqual({ keys: 0, models: 0, embeddings: 0, chain: 0 });
    expect(await db.get("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'groq'")).toEqual({ n: 1 });
    expect((await db.get("SELECT COUNT(*) AS n FROM models WHERE platform != 'auray'") as { n: number }).n).toBe(otherModels);
    const orphans = await db.get('SELECT COUNT(*) AS n FROM fallback_config f LEFT JOIN models m ON f.model_db_id = m.id WHERE m.id IS NULL') as { n: number };
    expect(orphans.n).toBe(0);

    await down(db);
    expect(await aurayCounts(db)).toEqual({ keys: 1, models: 1, embeddings: 1, chain: 1 });
    expect(await db.get('SELECT id, status, enabled FROM api_keys WHERE platform = ?', ['auray']))
      .toEqual({ id: keyId, status: 'healthy', enabled: 1 });
    expect(await db.get("SELECT value FROM settings WHERE key = 'migration_auray_removed_rows'")).toBeUndefined();
  });
});
