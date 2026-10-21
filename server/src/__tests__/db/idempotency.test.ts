import { describe, it, expect } from 'vitest';
import { getDb } from '../../db/index.js';
import { runMigrations } from '../../db/migrate/runner.js';
import { initTestDb } from '../helpers/test-db.js';
import { initTestDb } from '../helpers/test-db.js';

/**
 * All migrations must be idempotent: re-running every migration on the same
 * physical database must produce identical state (the PG equivalent of the
 * old dual initDb() on one SQLite file).
 */
describe('Migration idempotency', () => {
  it('re-running migrations on the same database produces identical row counts', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
    const db = getDb();
    const counts = async () => ({
      models: (await db.get('SELECT COUNT(*) AS c FROM models') as { c: number }).c,
      fallback: (await db.get('SELECT COUNT(*) AS c FROM fallback_config') as { c: number }).c,
      enabledModels: (await db.get('SELECT COUNT(*) AS c FROM models WHERE enabled = 1') as { c: number }).c,
      disabledModels: (await db.get('SELECT COUNT(*) AS c FROM models WHERE enabled = 0') as { c: number }).c,
      orphanFallbacks: (await db.get(`
        SELECT COUNT(*) AS c FROM fallback_config f
        LEFT JOIN models m ON f.model_db_id = m.id
        WHERE m.id IS NULL
      `) as { c: number }).c,
    });

    const before = await counts();
    // V1..V25 should all no-op idempotently on an already-migrated database.
    await runMigrations(db, 'up');
    const after = await counts();

    expect(after).toEqual(before);
    expect(after.orphanFallbacks).toBe(0);
  });

  it('every catalog row has exactly one fallback_config entry', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = await initTestDb();

    const rows = await db.all(`
      SELECT m.id, COUNT(f.id) AS fb_count
        FROM models m
        LEFT JOIN fallback_config f ON m.id = f.model_db_id
       GROUP BY m.id
      HAVING COUNT(f.id) <> 1
    `) as { id: number; fb_count: number }[];

    expect(rows).toEqual([]);
  });

  it('UNIQUE(platform, model_id) constraint holds — no duplicate catalog rows', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = await initTestDb();

    const dups = await db.all(`
      SELECT platform, model_id, COUNT(*) AS c FROM models
       GROUP BY platform, model_id
      HAVING COUNT(*) > 1
    `);

    expect(dups).toEqual([]);
  });

  it('V12: dead OR :free rows are absent and the four new rows are present', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = await initTestDb();

    const dead = await db.all(`
      SELECT model_id FROM models
       WHERE platform = 'openrouter'
         AND model_id IN ('inclusionai/ling-2.6-1t:free', 'tencent/hy3-preview:free')
    `);
    expect(dead).toEqual([]);

    // V21 pruned these three after live probing returned 404 "no endpoints found".
    const pruned = await db.all(`
      SELECT model_id FROM models
       WHERE platform = 'openrouter'
         AND model_id IN (
           'arcee-ai/trinity-large-thinking:free',
           'minimax/minimax-m2.5:free',
           'baidu/cobuddy:free'
         )
    `);
    expect(pruned).toEqual([]);

    const live = await db.all(`
      SELECT model_id FROM models
       WHERE platform = 'openrouter'
         AND model_id IN (
           'openrouter/owl-alpha',
           'nousresearch/hermes-3-llama-3.1-405b:free'
         )
       ORDER BY model_id
    `) as { model_id: string }[];
    expect(live.map(r => r.model_id)).toEqual([
      'nousresearch/hermes-3-llama-3.1-405b:free',
      'openrouter/owl-alpha',
    ]);

    const widened = await db.all(`
      SELECT model_id, context_window FROM models
       WHERE platform = 'openrouter'
         AND model_id IN ('nvidia/nemotron-3-super-120b-a12b:free', 'qwen/qwen3-coder:free')
       ORDER BY model_id
    `) as { model_id: string; context_window: number }[];
    expect(widened).toEqual([
      { model_id: 'nvidia/nemotron-3-super-120b-a12b:free', context_window: 1000000 },
      { model_id: 'qwen/qwen3-coder:free', context_window: 1048576 },
    ]);
  });

  it('V13: cross-provider catalog refresh applies cleanly', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = await initTestDb();

    // Disables — row kept but enabled=0.
    const disabled = await db.all(`
      SELECT platform, model_id, enabled FROM models
       WHERE (platform = 'google' AND model_id = 'gemini-3.1-pro-preview')
          OR (platform = 'ollama' AND model_id IN ('kimi-k2-thinking', 'mistral-large-3:675b', 'deepseek-v3.2'))
       ORDER BY platform, model_id
    `) as { platform: string; model_id: string; enabled: number }[];
    expect(disabled).toHaveLength(4);
    for (const row of disabled) expect(row.enabled).toBe(0);

    // Hard removals — row is gone entirely.
    const removed = await db.all(`
      SELECT model_id FROM models
       WHERE (platform = 'sambanova' AND model_id = 'DeepSeek-V3.1-cb')
          OR (platform = 'cloudflare' AND model_id = '@cf/moonshotai/kimi-k2.5')
    `);
    expect(removed).toEqual([]);

    // New rows present across providers (incl. new huggingface platform).
    const additions = await db.all(`
      SELECT platform, model_id FROM models
       WHERE (platform, model_id) IN (VALUES
         ('groq',        'openai/gpt-oss-safeguard-20b'),
         ('cloudflare',  '@cf/nvidia/nemotron-3-120b-a12b'),
         ('cloudflare',  '@cf/google/gemma-4-26b-a4b-it'),
         ('google',      'gemini-3.5-flash'),
         ('nvidia',      'deepseek-ai/deepseek-v4-flash'),
         ('nvidia',      'z-ai/glm-5.1'),
         ('nvidia',      'qwen/qwen3-coder-480b-a35b-instruct'),
         ('mistral',     'mistral-small-latest'),
         ('mistral',     'ministral-8b-latest'),
         ('cohere',      'command-a-reasoning-08-2025'),
         ('cohere',      'command-r-08-2024'),
         ('ollama',      'qwen3-coder-next'),
         ('huggingface', 'deepseek-ai/DeepSeek-V4-Flash'),
         ('huggingface', 'moonshotai/Kimi-K2.6'),
         ('huggingface', 'Qwen/Qwen3-Coder-Next')
       )
    `);
    expect(additions).toHaveLength(15);

    // Spot-check critical limit/context updates.
    const cerebrasLimits = await db.get(`
      SELECT rpm_limit, rpd_limit, tpm_limit, tpd_limit FROM models
       WHERE platform = 'cerebras' AND model_id = 'qwen-3-235b-a22b-instruct-2507'
    `) as { rpm_limit: number; rpd_limit: number; tpm_limit: number; tpd_limit: number };
    expect(cerebrasLimits).toEqual({ rpm_limit: 5, rpd_limit: 2400, tpm_limit: 30000, tpd_limit: 1000000 });

    const cfFp8Ctx = (await db.get(`
      SELECT context_window FROM models WHERE platform = 'cloudflare' AND model_id = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
    `) as { context_window: number }).context_window;
    expect(cfFp8Ctx).toBe(24000);

    const mistralCtx = await db.all(`
      SELECT model_id, context_window FROM models
       WHERE platform = 'mistral'
         AND model_id IN ('codestral-latest', 'devstral-latest', 'magistral-medium-latest', 'mistral-large-latest')
       ORDER BY model_id
    `) as { model_id: string; context_window: number }[];
    expect(mistralCtx).toEqual([
      { model_id: 'codestral-latest',       context_window: 256000 },
      { model_id: 'devstral-latest',        context_window: 262144 },
      { model_id: 'magistral-medium-latest', context_window: 131072 },
      { model_id: 'mistral-large-latest',   context_window: 262144 },
    ]);
  });

  it('removes the retired GitHub Models provider (#1557)', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = await initTestDb();

    for (const table of ['models', 'embedding_models', 'api_keys']) {
      expect((await db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE platform = 'github'`) as { n: number }).n).toBe(0);
    }
  });

  it('V14: cerebras deprecation disables qwen-3-235b and llama3.1-8b but keeps gpt-oss-120b enabled', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = await initTestDb();

    const rows = await db.all(`
      SELECT model_id, enabled FROM models
       WHERE platform = 'cerebras'
         AND model_id IN ('qwen-3-235b-a22b-instruct-2507', 'llama3.1-8b', 'gpt-oss-120b')
       ORDER BY model_id
    `) as { model_id: string; enabled: number }[];

    expect(rows).toEqual([
      { model_id: 'gpt-oss-120b',                    enabled: 1 },
      { model_id: 'llama3.1-8b',                     enabled: 0 },
      { model_id: 'qwen-3-235b-a22b-instruct-2507',  enabled: 0 },
    ]);
  });

  it('V23: sambanova/chutes are gone; live-verified free additions are present with the right flags', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = await initTestDb();

    // Platform drops — no model, fallback, or key rows survive.
    const deadRows = await db.get(`SELECT COUNT(*) AS n FROM models WHERE platform IN ('sambanova', 'chutes')`) as { n: number };
    expect(deadRows.n).toBe(0);
    const deadKeys = await db.get(`SELECT COUNT(*) AS n FROM api_keys WHERE platform IN ('sambanova', 'chutes')`) as { n: number };
    expect(deadKeys.n).toBe(0);

    // Additions, with the flags the live probe verified (vision/tools come
    // from the V16/V22 rules, so they must hold on a fresh seed too).
    const added = await db.all(`
      SELECT platform, model_id, enabled, supports_vision, supports_tools FROM models
       WHERE (platform = 'openrouter' AND model_id IN (
               'moonshotai/kimi-k2.6:free',
               'nvidia/nemotron-3-ultra-550b-a55b:free',
               'nvidia/nemotron-nano-12b-v2-vl:free',
               'meta-llama/llama-3.2-3b-instruct:free',
               'cognitivecomputations/dolphin-mistral-24b-venice-edition:free'))
          OR (platform = 'zhipu' AND model_id = 'glm-4.6v-flash')
       ORDER BY platform, model_id
    `) as { model_id: string; enabled: number; supports_vision: number; supports_tools: number }[];
    expect(added.map(r => [r.model_id, r.enabled, r.supports_vision, r.supports_tools])).toEqual([
      ['cognitivecomputations/dolphin-mistral-24b-venice-edition:free', 1, 0, 0],
      ['meta-llama/llama-3.2-3b-instruct:free',                         1, 0, 0],
      ['moonshotai/kimi-k2.6:free',                                     1, 0, 1],
      ['nvidia/nemotron-3-ultra-550b-a55b:free',                        0, 0, 1], // hangs 180s+; seeded disabled (tools verified via Zen in V24)
      ['nvidia/nemotron-nano-12b-v2-vl:free',                           1, 1, 1],
      ['glm-4.6v-flash',                                                1, 1, 1],
    ]);
  });

  it('V24: Zen roster refresh lands and the hung NIM gemma is paused', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = await initTestDb();

    const zen = await db.all(`
      SELECT model_id, enabled, supports_tools FROM models
       WHERE platform = 'opencode' AND model_id IN ('nemotron-3-ultra-free', 'minimax-m3-free')
       ORDER BY model_id
    `) as { model_id: string; enabled: number; supports_tools: number }[];
    expect(zen.map(r => [r.model_id, r.enabled, r.supports_tools])).toEqual([
      // minimax-m3-free was seeded enabled here in V24, then retired in V25 when
      // its free promo ended (now enabled=0). nemotron-3-ultra-free is still live.
      ['minimax-m3-free',       0, 1],
      ['nemotron-3-ultra-free', 1, 1],
    ]);

    // The hung NIM gemma route is paused (row kept, enabled=0, re-asserted
    // each boot like the V13 disables).
    const gemma = await db.get(`
      SELECT enabled FROM models WHERE platform = 'nvidia' AND model_id = 'google/gemma-4-31b-it'
    `) as { enabled: number };
    expect(gemma.enabled).toBe(0);
  });

  it('V25: dead OpenCode Zen free promos (nemotron-3-super-free, minimax-m3-free) are disabled', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = await initTestDb();

    const dead = await db.all(`
      SELECT model_id, enabled FROM models
       WHERE platform = 'opencode' AND model_id IN ('nemotron-3-super-free', 'minimax-m3-free')
       ORDER BY model_id
    `) as { model_id: string; enabled: number }[];
    expect(dead.map(r => [r.model_id, r.enabled])).toEqual([
      ['minimax-m3-free',       0],
      ['nemotron-3-super-free', 0],
    ]);
  });

  it('all enabled catalog platforms have a registered provider', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const db = await initTestDb();
    const { hasProvider } = await import('../../providers/index.js');

    const platforms = (await db.all(`SELECT DISTINCT platform FROM models WHERE enabled = 1`) as { platform: any }[]).map(r => r.platform);

    const missing = platforms.filter(p => !hasProvider(p));
    expect(missing).toEqual([]);
  });
});
