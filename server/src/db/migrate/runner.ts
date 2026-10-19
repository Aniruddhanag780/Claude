import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import pg from 'pg';
import { DEFAULT_MIGRATIONS, type MigrationModule } from './defaults.js';

export type MigrationDirection = 'up' | 'down';
export type MigrationState = 'applied' | 'pending';

export interface MigrationRunnerOptions {
  migrationsDir?: string;
  migrationFileExtension?: '.ts' | '.js';
}

export interface MigrationStatus {
  filename: string;
  status: MigrationState;
  appliedAt: string | null;
}

interface MigrationRecord {
  filename: string;
  module?: MigrationModule;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS migrations (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(255) NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

/**
 * The `migrations` ledger is the source of truth for what has been applied. If
 * it records migrations that no longer exist on disk (a migration file was
 * deleted after being applied, or the ledger belongs to a different branch),
 * running more migrations would silently diverge from that history. Fail loud
 * with a diagnostic instead: history is never auto-rewritten and migrations
 * never run past an inconsistent ledger.
 */
export async function assertMigrationHistoryCompatible(
  pool: pg.Pool,
  options: MigrationRunnerOptions = {},
): Promise<void> {
  await ensureMigrationsTable(pool);
  const applied = await getAppliedMigrations(pool);
  const registered = new Set(getMigrationRecords(options).map(record => record.filename));
  const unknown = [...applied.keys()].filter(filename => !registered.has(filename));
  if (unknown.length === 0) return;
  throw new Error(
    `[migration] Incompatible migration history: ${unknown.length} recorded migration(s) in the ` +
      `'migrations' ledger have no corresponding migration file: ${unknown.sort().join(', ')}. ` +
      'Reconcile the ledger manually so it matches the files on disk. ' +
      'Migrations will not run until the history is consistent — it is never auto-rewritten.',
  );
}

export async function runMigrations(
  pool: pg.Pool,
  direction: MigrationDirection = 'up',
  options: MigrationRunnerOptions = {},
): Promise<void> {
  await ensureMigrationsTable(pool);
  await assertMigrationHistoryCompatible(pool, options);
  const records = getMigrationRecords(options);

  if (direction === 'up') {
    await runPendingMigrations(pool, records, options);
    return;
  }

  if (direction === 'down') {
    await runLatestDownMigration(pool, records, options);
    return;
  }

  throw new Error(`Unknown migration direction: ${direction}`);
}

const DEFAULT_PROVIDERS = [
  { key: 'google', name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com', priority: 10 },
  { key: 'groq', name: 'Groq', url: 'https://api.groq.com/openai/v1', priority: 9 },
  { key: 'cerebras', name: 'Cerebras', url: 'https://api.cerebras.ai/v1', priority: 9 },
  { key: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', priority: 8 },
  { key: 'mistral', name: 'Mistral AI', url: 'https://api.mistral.ai/v1', priority: 7 },
  { key: 'github', name: 'GitHub Models', url: 'https://models.github.ai/inference', priority: 7 },
  { key: 'cohere', name: 'Cohere', url: 'https://api.cohere.com/v2', priority: 6 },
  { key: 'cloudflare', name: 'Cloudflare Workers AI', url: 'https://api.cloudflare.com/client/v4', priority: 5 },
  { key: 'zhipu', name: 'Zhipu AI (GLM)', url: 'https://open.bigmodel.cn/api/paas/v4', priority: 6 },
  { key: 'ollama', name: 'Ollama Cloud', url: 'https://ollama.com/v1', priority: 5 },
  { key: 'kilo', name: 'Kilo Gateway', url: 'https://api.kilo.ai/api/gateway/v1', priority: 4 },
  { key: 'pollinations', name: 'Pollinations', url: 'https://gen.pollinations.ai/v1', priority: 4 },
  { key: 'llm7', name: 'LLM7', url: 'https://api.llm7.io/v1', priority: 3 },
  { key: 'opencode', name: 'OpenCode Zen', url: 'https://opencode.ai/zen/v1', priority: 3 },
  { key: 'ovh', name: 'OVHcloud AI', url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', priority: 3 },
  { key: 'custom', name: 'Custom OpenAI Endpoint', url: null, priority: 1 },
];

const DEFAULT_MODELS = [
  { provider: 'google', modelId: 'gemini-2.5-pro', canonical: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', ctx: 1048576, maxOut: 8192, stream: true, tools: true, vision: true, structOut: true, reasoning: true, priority: 10 },
  { provider: 'google', modelId: 'gemini-2.5-flash', canonical: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', ctx: 1048576, maxOut: 8192, stream: true, tools: true, vision: true, structOut: true, reasoning: true, priority: 9 },
  { provider: 'google', modelId: 'gemini-2.5-flash-lite', canonical: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', ctx: 1048576, maxOut: 8192, stream: true, tools: true, vision: true, structOut: true, reasoning: false, priority: 8 },
  { provider: 'groq', modelId: 'llama-3.3-70b-versatile', canonical: 'llama-3.3-70b', name: 'Llama 3.3 70B (Groq)', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 9 },
  { provider: 'groq', modelId: 'llama-4-scout-17b-16e-instruct', canonical: 'llama-4-scout', name: 'Llama 4 Scout (Groq)', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 8 },
  { provider: 'cerebras', modelId: 'qwen-3-coder-480b', canonical: 'qwen-3-coder', name: 'Qwen3-Coder 480B (Cerebras)', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: true, priority: 9 },
  { provider: 'cerebras', modelId: 'llama-4-maverick-17b-128e-instruct', canonical: 'llama-4-maverick', name: 'Llama 4 Maverick (Cerebras)', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 8 },
  { provider: 'openrouter', modelId: 'deepseek/deepseek-v3.1:free', canonical: 'deepseek-v3.1', name: 'DeepSeek V3.1 (free)', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: true, priority: 9 },
  { provider: 'openrouter', modelId: 'moonshotai/kimi-k2:free', canonical: 'kimi-k2', name: 'Kimi K2 (free)', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 8 },
  { provider: 'openrouter', modelId: 'qwen/qwen3-coder:free', canonical: 'qwen3-coder', name: 'Qwen3 Coder (free)', ctx: 262144, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: true, priority: 8 },
  { provider: 'openrouter', modelId: 'moonshotai/kimi-k2.6:free', canonical: 'kimi-k2.6', name: 'Kimi K2.6 (OR free)', ctx: 262144, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 3 },
  { provider: 'mistral', modelId: 'mistral-large-latest', canonical: 'mistral-large', name: 'Mistral Large 3', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: true, structOut: true, reasoning: false, priority: 8 },
  { provider: 'mistral', modelId: 'codestral-latest', canonical: 'codestral', name: 'Codestral', ctx: 32000, maxOut: 4096, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 7 },
  { provider: 'github', modelId: 'openai/gpt-5', canonical: 'gpt-5', name: 'GPT-5 (GitHub)', ctx: 128000, maxOut: 8192, stream: true, tools: true, vision: true, structOut: true, reasoning: true, priority: 10 },
  { provider: 'github', modelId: 'openai/gpt-4.1', canonical: 'gpt-4.1', name: 'GPT-4.1 (GitHub)', ctx: 8000, maxOut: 4000, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 20 },
  { provider: 'zhipu', modelId: 'glm-4.5-flash', canonical: 'glm-4.5-flash', name: 'GLM-4.5 Flash', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 7 },
];

function seedBaselineModelsSync(db: any): void {
  if (!db?.prepare) return;
  const providerMap = new Map<string, number>();
  for (const p of DEFAULT_PROVIDERS) {
    let row = db.prepare('SELECT id FROM providers WHERE provider_key = ?').get(p.key) as { id: number } | undefined;
    if (!row) {
      db.prepare('INSERT INTO providers (provider_key, display_name, base_url, enabled, priority) VALUES (?, ?, ?, 1, ?)').run(p.key, p.name, p.url, p.priority);
      row = db.prepare('SELECT id FROM providers WHERE provider_key = ?').get(p.key) as { id: number } | undefined;
    }
    if (row) providerMap.set(p.key, row.id);
  }

  for (const m of DEFAULT_MODELS) {
    const provId = providerMap.get(m.provider);
    if (!provId) continue;
    let row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(m.provider, m.modelId) as { id: number } | undefined;
    if (!row) {
      db.prepare(`
        INSERT INTO models (
          provider_id, platform, model_id, canonical_name, display_name, enabled,
          context_window, max_output_tokens, supports_streaming, supports_tools,
          supports_vision, supports_structured_output, supports_reasoning, priority, source
        )
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'catalog')
      `).run(provId, m.provider, m.modelId, m.canonical, m.name, m.ctx, m.maxOut, m.stream ? 1 : 0, m.tools ? 1 : 0, m.vision ? 1 : 0, m.structOut ? 1 : 0, m.reasoning ? 1 : 0, m.priority);
      row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(m.provider, m.modelId) as { id: number } | undefined;
      if (row) {
        try {
          db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1) ON CONFLICT (model_db_id) DO NOTHING').run(row.id, m.priority);
        } catch {}
      }
    }
  }
}

export function runMigrationsSync(
  db: any,
  direction: MigrationDirection = 'up',
): void {
  try {
    db.prepare?.(CREATE_MIGRATIONS_TABLE_SQL).run?.();
  } catch {}

  const appliedRows = db.prepare?.('SELECT filename FROM migrations').all?.() ?? [];
  const applied = new Set<string>(appliedRows.map((r: any) => r.filename));
  const records = getMigrationRecords({});

  if (direction === 'up') {
    for (const record of records) {
      if (applied.has(record.filename)) continue;
      try {
        db.prepare?.('INSERT INTO migrations (filename) VALUES (?)').run?.(record.filename);
      } catch {}
      applied.add(record.filename);
    }
    seedBaselineModelsSync(db);
    return;
  }

  if (direction === 'down') {
    return;
  }

  throw new Error(`Unknown migration direction: ${direction}`);
}

export async function getMigrationStatuses(
  pool: pg.Pool,
  options: MigrationRunnerOptions = {},
): Promise<MigrationStatus[]> {
  await ensureMigrationsTable(pool);
  await assertMigrationHistoryCompatible(pool, options);

  const applied = await getAppliedMigrations(pool);
  return getMigrationRecords(options).map(record => ({
    filename: record.filename,
    status: applied.has(record.filename) ? 'applied' : 'pending',
    appliedAt: applied.get(record.filename) ?? null,
  }));
}

async function ensureMigrationsTable(pool: pg.Pool): Promise<void> {
  await pool.query(CREATE_MIGRATIONS_TABLE_SQL);
}

async function runPendingMigrations(
  pool: pg.Pool,
  records: readonly MigrationRecord[],
  options: MigrationRunnerOptions,
): Promise<void> {
  const applied = await getAppliedMigrations(pool);

  for (const record of records) {
    if (applied.has(record.filename)) continue;

    const migration = await loadMigrationModule(record, options);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await migration.up(client);
      await client.query('INSERT INTO migrations (filename) VALUES ($1)', [record.filename]);
      await client.query('COMMIT');
      applied.set(record.filename, new Date().toISOString());
      console.log(`[migration] Applied ${record.filename}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

async function runLatestDownMigration(
  pool: pg.Pool,
  records: readonly MigrationRecord[],
  options: MigrationRunnerOptions,
): Promise<void> {
  const res = await pool.query(`
    SELECT filename
      FROM migrations
     ORDER BY id DESC
     LIMIT 1
  `);
  const row = res.rows[0] as { filename: string } | undefined;
  if (!row) return;

  const record = records.find(r => r.filename === row.filename);
  if (!record) throw new Error(`Migration file not found: ${row.filename}`);

  const migration = await loadMigrationModule(record, options);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await migration.down(client);
    await client.query('DELETE FROM migrations WHERE filename = $1', [row.filename]);
    await client.query('COMMIT');
    console.log(`[migration] Reverted ${row.filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getAppliedMigrations(pool: pg.Pool): Promise<Map<string, string>> {
  const res = await pool.query(`
    SELECT filename, applied_at
      FROM migrations
     ORDER BY filename ASC
  `);
  return new Map(res.rows.map((row: any) => [row.filename, new Date(row.applied_at).toISOString()]));
}

function getMigrationRecords(options: MigrationRunnerOptions): MigrationRecord[] {
  if (isDefaultMigrationSet(options)) return [...DEFAULT_MIGRATIONS];

  return getMigrationFilenames(options).map(filename => ({ filename }));
}

function getMigrationFilenames(options: MigrationRunnerOptions): string[] {
  const migrationsDir = getMigrationsDir(options);
  if (!fs.existsSync(migrationsDir)) return [];

  const extension = getMigrationFileExtension(options);
  return fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(filename => filename.endsWith(extension) && !filename.endsWith('.d.ts'))
    .sort((left, right) => left.localeCompare(right));
}

async function loadMigrationModule(
  record: MigrationRecord,
  options: MigrationRunnerOptions,
): Promise<MigrationModule> {
  if (record.module) return record.module;

  const migrationPath = path.join(getMigrationsDir(options), record.filename);
  if (!fs.existsSync(migrationPath)) {
    throw new Error(`Migration file not found: ${record.filename}`);
  }

  const imported = await import(pathToFileURL(migrationPath).href) as Partial<MigrationModule>;
  if (typeof imported.up !== 'function' || typeof imported.down !== 'function') {
    throw new Error(`Migration ${record.filename} must export up(client) and down(client) functions`);
  }

  return {
    up: imported.up,
    down: imported.down,
  };
}

function isDefaultMigrationSet(options: MigrationRunnerOptions): boolean {
  return options.migrationsDir === undefined && options.migrationFileExtension === undefined;
}

function getMigrationsDir(options: MigrationRunnerOptions): string {
  return options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
}

function getMigrationFileExtension(options: MigrationRunnerOptions): '.ts' | '.js' {
  if (options.migrationFileExtension) return options.migrationFileExtension;
  return fileURLToPath(import.meta.url).endsWith('.ts') ? '.ts' : '.js';
}
