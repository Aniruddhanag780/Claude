import pg from 'pg';
import { execStatement, nowIso } from './mock-sql.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number | null;
}

export interface PostgresDb {
  query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
  getClient(): Promise<pg.PoolClient>;
  transaction<T>(callback: (client: pg.PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  isMock(): boolean;
}

export interface SslResolution {
  /** Value for pg.PoolConfig.ssl. `undefined` means "let the driver decide"
   *  (no programmatic override — used when the connection string already
   *  carries an explicit sslmode, which pg-connection-string applies itself). */
  ssl?: pg.PoolConfig['ssl'];
  /** Human-readable note for startup logs (why this choice was made). */
  reason: string;
}

/**
 * Decide the TLS setting for a Postgres connection, verifying the server
 * certificate by default.
 *
 * Precedence (mirrors how node-postgres actually behaves — `pg` merges the
 * parsed connection string OVER programmatic config, so an explicit `sslmode`
 * in DATABASE_URL always wins):
 *
 *   1. Explicit `sslmode` / `sslrootcert` / `sslcert` / `sslkey` in the URL
 *      → return `ssl: undefined` so pg-connection-string applies the URL
 *         verbatim. We never second-guess an explicit operator setting, and we
 *         never fight it with a conflicting programmatic value.
 *   2. No URL SSL params, host is local (localhost / 127.0.0.1 / ::1)
 *      → `ssl: undefined` (plain connection). Local dev Postgres typically
 *         speaks no TLS; forcing it would break `docker run postgres`.
 *   3. No URL SSL params, non-local host (production / Neon / managed)
 *      → `ssl: { rejectUnauthorized: true }`: encrypt AND verify the server
 *         certificate and hostname against the system CA store. Neon's
 *         certificate is signed by a public CA, so this works out of the box.
 *
 * Escape hatch (explicit, off by default): set PGSSL_NO_VERIFY=true to connect
 * to a non-local server with a self-signed / private-CA certificate without
 * verification. This is the ONLY path that disables verification, it is never
 * the default, and it logs a warning so it cannot be enabled silently.
 */
export function resolveSslConfig(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): SslResolution {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ssl: undefined, reason: 'unparsable connection string; leaving SSL to the driver' };
  }

  // 1. An explicit SSL setting in the URL is authoritative — do not override it.
  const params = parsed.searchParams;
  const explicit =
    params.has('sslmode') ||
    params.has('sslrootcert') ||
    params.has('sslcert') ||
    params.has('sslkey') ||
    params.has('ssl');
  if (explicit) {
    return {
      ssl: undefined,
      reason: 'connection string carries an explicit sslmode/ssl* setting; honouring it verbatim',
    };
  }

  // 2. Local development hosts: no TLS unless the operator asked for it above.
  const host = (parsed.hostname || '').toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (isLocal) {
    return { ssl: undefined, reason: 'local host without explicit sslmode; using a plain connection' };
  }

  // 3. Non-local (production / Neon / managed): verify the certificate.
  const noVerify = /^(1|true|yes)$/i.test(env.PGSSL_NO_VERIFY ?? '');
  if (noVerify) {
    console.warn(
      '[db] PGSSL_NO_VERIFY is set: TLS certificate verification is DISABLED for this non-local Postgres. ' +
        'Traffic is encrypted but the server is not authenticated (vulnerable to MITM). Unset it unless you ' +
        'control the CA (e.g. a self-signed dev server).',
    );
    return {
      ssl: { rejectUnauthorized: false },
      reason: 'PGSSL_NO_VERIFY=true: encrypted but not verified (explicit opt-out)',
    };
  }

  return {
    ssl: { rejectUnauthorized: true },
    reason: 'non-local host: TLS enabled with certificate + hostname verification (system CA store)',
  };
}

/**
 * Parses DATABASE_URL or environment variables to configure the PostgreSQL pool.
 * Neon PostgreSQL requires SSL.
 */
export function createPostgresPool(connectionString?: string): pg.Pool {
  const url = connectionString || process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_DATABASE_URL;
  
  if (!url) {
    throw new Error(
      'DATABASE_URL environment variable is required for PostgreSQL connection.\n' +
      'Example: postgresql://user:password@ep-sample.us-east-2.aws.neon.tech/neondb?sslmode=require'
    );
  }

  const poolConfig: pg.PoolConfig = {
    connectionString: url,
    max: Number(process.env.PG_MAX_CONNECTIONS || 10), // Small pool for Render/Neon Free Tier
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };

  const tls = resolveSslConfig(url);
  if (tls.ssl !== undefined) {
    poolConfig.ssl = tls.ssl;
  }

  const createdPool = new Pool(poolConfig);
  const poolAny = createdPool as any;

  // SQLite-compatibility shims. They used to run statements against an
  // in-memory Map (never Postgres), so a production `run()` reported
  // `{changes:1}` while `SELECT COUNT(*)` stayed 0 — a silent fake write. pg is
  // async, so there is no way to keep these synchronous call sites honest
  // without porting them to `await pool.query()`. Until each call site is
  // ported, fail loudly so the defect is visible instead of silently
  // fabricating data. See the remediation plan; destination tables already
  // exist via migrations 006/007.
  const sqliteCompatError = (api: string, sql?: unknown): Error =>
    new Error(
      `[db] ${api}() is a SQLite compatibility API and is not available on the PostgreSQL pool. ` +
        `Port this call site to \`await pool.query()\` with $1..$n placeholders. ` +
        (sql !== undefined
          ? 'Offending SQL: ' + String(sql).replace(/\s+/g, ' ').trim().slice(0, 200)
          : ''),
    );

  poolAny.prepare = (sql: string) => ({
    get: () => { throw sqliteCompatError('prepare.get', sql); },
    all: () => { throw sqliteCompatError('prepare.all', sql); },
    run: () => { throw sqliteCompatError('prepare.run', sql); },
  });
  poolAny.exec = (sql?: unknown) => { throw sqliteCompatError('exec', sql); };
  poolAny.transaction = () => { throw sqliteCompatError('transaction'); };
  poolAny.pragma = () => { throw sqliteCompatError('pragma'); };
  return createdPool;
}

/**
 * Initializes the singleton Postgres pool.
 */
const mockPoolStorage: Map<string, Map<string, any[]>> = ((globalThis as any).__mockPoolStorage ??= new Map());

export function initPostgresPool(connectionString?: string): pg.Pool {
  const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
  const useRealPg = Boolean(process.env.USE_REAL_POSTGRES);

  if (connectionString === ':memory:' && isTest && !useRealPg) {
    pool = createInMemoryMockPool() as any;
    return pool!;
  }

  if (pool) {
    return pool;
  }

  if (isTest && !useRealPg) {
    pool = createInMemoryMockPool(connectionString) as any;
    return pool!;
  }

  // Under USE_REAL_POSTGRES the suite still passes the literal ':memory:'
  // sentinel it uses for the mock. Treat it as "resolve from DATABASE_URL" so
  // the same tests can run against a disposable real Postgres for authoritative
  // verification instead of the SQLite-flavoured mock.
  const resolved =
    useRealPg && (connectionString === ':memory:' || connectionString === undefined)
      ? undefined
      : connectionString;

  pool = createPostgresPool(resolved);
  return pool;
}

export function getPostgresPool(): pg.Pool {
  if (!pool) {
    return initPostgresPool();
  }
  return pool;
}

export async function closePostgresPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

function seedMockDatabase(tables: Map<string, any[]>) {
  if (tables.get('providers')!.length === 0) {
    const provs = [
      { id: 1, provider_key: 'google', display_name: 'Google Gemini', base_url: 'https://generativelanguage.googleapis.com', enabled: 1, priority: 10 },
      { id: 2, provider_key: 'groq', display_name: 'Groq', base_url: 'https://api.groq.com/openai/v1', enabled: 1, priority: 9 },
      { id: 3, provider_key: 'cerebras', display_name: 'Cerebras', base_url: 'https://api.cerebras.ai/v1', enabled: 1, priority: 9 },
      { id: 4, provider_key: 'openrouter', display_name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', enabled: 1, priority: 8 },
      { id: 5, provider_key: 'mistral', display_name: 'Mistral AI', base_url: 'https://api.mistral.ai/v1', enabled: 1, priority: 7 },
      { id: 6, provider_key: 'github', display_name: 'GitHub Models', base_url: 'https://models.github.ai/inference', enabled: 1, priority: 7 },
      { id: 7, provider_key: 'cohere', display_name: 'Cohere', base_url: 'https://api.cohere.com/v2', enabled: 1, priority: 6 },
      { id: 8, provider_key: 'cloudflare', display_name: 'Cloudflare Workers AI', base_url: 'https://api.cloudflare.com/client/v4', enabled: 1, priority: 5 },
      { id: 9, provider_key: 'zhipu', display_name: 'Zhipu AI (GLM)', base_url: 'https://open.bigmodel.cn/api/paas/v4', enabled: 1, priority: 6 },
      { id: 10, provider_key: 'ollama', display_name: 'Ollama Cloud', base_url: 'https://ollama.com/v1', enabled: 1, priority: 5 },
      { id: 11, provider_key: 'kilo', display_name: 'Kilo Gateway', base_url: 'https://api.kilo.ai/api/gateway/v1', enabled: 1, priority: 4 },
      { id: 12, provider_key: 'pollinations', display_name: 'Pollinations', base_url: 'https://gen.pollinations.ai/v1', enabled: 1, priority: 4 },
      { id: 13, provider_key: 'llm7', display_name: 'LLM7', base_url: 'https://api.llm7.io/v1', enabled: 1, priority: 3 },
      { id: 14, provider_key: 'opencode', display_name: 'OpenCode Zen', base_url: 'https://opencode.ai/zen/v1', enabled: 1, priority: 3 },
      { id: 15, provider_key: 'ovh', display_name: 'OVHcloud AI', base_url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', enabled: 1, priority: 3 },
      { id: 16, provider_key: 'nvidia', display_name: 'NVIDIA NIM', base_url: 'https://integrate.api.nvidia.com/v1', enabled: 1, priority: 6 },
      { id: 17, provider_key: 'custom', display_name: 'Custom OpenAI Endpoint', base_url: null, enabled: 1, priority: 1 },
    ];
    tables.get('providers')!.push(...provs);
  }

  if (tables.get('models')!.length === 0) {
    const rawModels = [
      { id: 1, provider_id: 1, platform: 'google', model_id: 'gemini-2.5-pro', canonical_name: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', intelligence_rank: 1, speed_rank: 8, size_label: 'Frontier', rpm_limit: 5, rpd_limit: 100, tpm_limit: 250000, context_window: 1048576, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 1, supports_structured_output: 1, supports_reasoning: 1, priority: 10, source: 'catalog' },
      { id: 2, provider_id: 1, platform: 'google', model_id: 'gemini-2.5-flash', canonical_name: 'gemini-2.5-flash', display_name: 'Gemini 2.5 Flash', intelligence_rank: 4, speed_rank: 5, size_label: 'Large', rpm_limit: 10, rpd_limit: 20, tpm_limit: 250000, context_window: 1048576, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 1, supports_structured_output: 1, supports_reasoning: 1, priority: 9, source: 'catalog' },
      { id: 3, provider_id: 1, platform: 'google', model_id: 'gemini-2.5-flash-lite', canonical_name: 'gemini-2.5-flash-lite', display_name: 'Gemini 2.5 Flash-Lite', intelligence_rank: 8, speed_rank: 3, size_label: 'Medium', rpm_limit: 15, rpd_limit: 1000, tpm_limit: 250000, context_window: 1048576, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 1, supports_structured_output: 1, supports_reasoning: 0, priority: 8, source: 'catalog' },
      { id: 4, provider_id: 2, platform: 'groq', model_id: 'llama-3.3-70b-versatile', canonical_name: 'llama-3.3-70b', display_name: 'Llama 3.3 70B (Groq)', intelligence_rank: 9, speed_rank: 2, size_label: 'Medium', rpm_limit: 30, rpd_limit: 1000, tpm_limit: 6000, context_window: 131072, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 0, priority: 9, source: 'catalog' },
      { id: 5, provider_id: 2, platform: 'groq', model_id: 'llama-4-scout-17b-16e-instruct', canonical_name: 'llama-4-scout', display_name: 'Llama 4 Scout (Groq)', intelligence_rank: 10, speed_rank: 2, size_label: 'Medium', rpm_limit: 30, rpd_limit: 1000, tpm_limit: 6000, context_window: 131072, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 0, priority: 8, source: 'catalog' },
      { id: 6, provider_id: 3, platform: 'cerebras', model_id: 'qwen-3-coder-480b', canonical_name: 'qwen-3-coder', display_name: 'Qwen3-Coder 480B (Cerebras)', intelligence_rank: 2, speed_rank: 1, size_label: 'Frontier', rpm_limit: 30, rpd_limit: null, tpm_limit: 60000, context_window: 131072, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 1, priority: 9, source: 'catalog' },
      { id: 7, provider_id: 3, platform: 'cerebras', model_id: 'llama-4-maverick-17b-128e-instruct', canonical_name: 'llama-4-maverick', display_name: 'Llama 4 Maverick (Cerebras)', intelligence_rank: 3, speed_rank: 1, size_label: 'Frontier', rpm_limit: 30, rpd_limit: null, tpm_limit: 60000, context_window: 131072, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 0, priority: 8, source: 'catalog' },
      { id: 8, provider_id: 4, platform: 'openrouter', model_id: 'deepseek/deepseek-v3.1:free', canonical_name: 'deepseek-v3.1', display_name: 'DeepSeek V3.1 (free)', intelligence_rank: 2, speed_rank: 10, size_label: 'Frontier', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, context_window: 131072, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 1, priority: 9, source: 'catalog' },
      { id: 9, provider_id: 4, platform: 'openrouter', model_id: 'moonshotai/kimi-k2:free', canonical_name: 'kimi-k2', display_name: 'Kimi K2 (free)', intelligence_rank: 2, speed_rank: 9, size_label: 'Frontier', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, context_window: 131072, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 0, priority: 8, source: 'catalog' },
      { id: 10, provider_id: 4, platform: 'openrouter', model_id: 'qwen/qwen3-coder:free', canonical_name: 'qwen3-coder', display_name: 'Qwen3 Coder (free)', intelligence_rank: 3, speed_rank: 9, size_label: 'Frontier', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, context_window: 262144, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 1, priority: 8, source: 'catalog' },
      { id: 11, provider_id: 4, platform: 'openrouter', model_id: 'nvidia/nemotron-3-ultra-550b-a55b:free', canonical_name: 'nemotron-3-ultra', display_name: 'Nemotron 3 Ultra 550B (free, slow)', intelligence_rank: 7, speed_rank: 11, size_label: 'Frontier', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, context_window: 1000000, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 0, priority: 7, source: 'catalog' },
      { id: 12, provider_id: 5, platform: 'mistral', model_id: 'mistral-large-latest', canonical_name: 'mistral-large', display_name: 'Mistral Large 3', intelligence_rank: 7, speed_rank: 8, size_label: 'Large', rpm_limit: 2, rpd_limit: null, tpm_limit: 500000, context_window: 131072, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 1, supports_structured_output: 1, supports_reasoning: 0, priority: 8, source: 'catalog' },
      { id: 13, provider_id: 6, platform: 'github', model_id: 'openai/gpt-5', canonical_name: 'gpt-5', display_name: 'GPT-5 (GitHub)', intelligence_rank: 1, speed_rank: 7, size_label: 'Frontier', rpm_limit: 10, rpd_limit: 50, tpm_limit: null, context_window: 128000, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 1, supports_structured_output: 1, supports_reasoning: 1, priority: 10, source: 'catalog' },
      { id: 14, provider_id: 9, platform: 'zhipu', model_id: 'glm-4.5-flash', canonical_name: 'glm-4.5-flash', display_name: 'GLM-4.5 Flash', intelligence_rank: 5, speed_rank: 4, size_label: 'Large', rpm_limit: null, rpd_limit: null, tpm_limit: null, context_window: 131072, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 0, priority: 7, source: 'catalog' },
      { id: 15, provider_id: 16, platform: 'nvidia', model_id: 'meta/llama-3.1-70b-instruct', canonical_name: 'llama-3.1-70b', display_name: 'Llama 3.1 70B (NV)', intelligence_rank: 11, speed_rank: 6, size_label: 'Large', rpm_limit: 40, rpd_limit: null, tpm_limit: null, context_window: 131072, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 0, priority: 6, source: 'catalog' },
      { id: 16, provider_id: 14, platform: 'opencode', model_id: 'nemotron-3-ultra-free', canonical_name: 'nemotron-3-ultra', display_name: 'Nemotron 3 Ultra Free (OpenCode Zen)', intelligence_rank: 7, speed_rank: 4, size_label: 'Frontier', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, context_window: 131072, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 0, priority: 7, source: 'catalog' },
      { id: 17, provider_id: 2, platform: 'groq', model_id: 'llama-3.1-8b-instant', canonical_name: 'llama-3.1-8b-instant', display_name: 'Llama 3.1 8B Instant', intelligence_rank: 28, speed_rank: 2, size_label: 'Small', rpm_limit: 30, rpd_limit: 14400, tpm_limit: 6000, context_window: 131072, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 0, priority: 8, source: 'catalog' },
      { id: 18, provider_id: 6, platform: 'github', model_id: 'openai/gpt-4.1', canonical_name: 'gpt-4.1', display_name: 'GPT-4.1 (GitHub)', intelligence_rank: 20, speed_rank: 7, size_label: 'Large', rpm_limit: 10, rpd_limit: 50, tpm_limit: null, context_window: 8000, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 0, priority: 20, source: 'catalog' },
      { id: 19, provider_id: 4, platform: 'openrouter', model_id: 'moonshotai/kimi-k2.6:free', canonical_name: 'kimi-k2.6', display_name: 'Kimi K2.6 (OR free)', intelligence_rank: 3, speed_rank: 9, size_label: 'Frontier', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, context_window: 262144, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 0, priority: 3, source: 'catalog' },
      { id: 20, provider_id: 2, platform: 'groq', model_id: 'openai/gpt-oss-120b', canonical_name: 'gpt-oss-120b', display_name: 'GPT-OSS 120B (Groq)', intelligence_rank: 6, speed_rank: 2, size_label: 'Large', rpm_limit: 30, rpd_limit: 1000, tpm_limit: 8000, context_window: 131072, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 0, priority: 6, source: 'catalog' },
      { id: 21, provider_id: 2, platform: 'groq', model_id: 'openai/gpt-oss-20b', canonical_name: 'gpt-oss-20b', display_name: 'GPT-OSS 20B (Groq)', intelligence_rank: 18, speed_rank: 2, size_label: 'Medium', rpm_limit: 30, rpd_limit: 1000, tpm_limit: 8000, context_window: 131072, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 0, priority: 6, source: 'catalog' },
      { id: 22, provider_id: 2, platform: 'groq', model_id: 'qwen/qwen3-32b', canonical_name: 'qwen3-32b', display_name: 'Qwen3 32B (Groq)', intelligence_rank: 19, speed_rank: 2, size_label: 'Medium', rpm_limit: 60, rpd_limit: 1000, tpm_limit: 6000, context_window: 131072, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 0, priority: 6, source: 'catalog' },
      { id: 23, provider_id: 4, platform: 'openrouter', model_id: 'nousresearch/hermes-3-llama-3.1-405b:free', canonical_name: 'hermes-3', display_name: 'Hermes 3 (free)', intelligence_rank: 6, speed_rank: 9, size_label: 'Large', rpm_limit: 20, rpd_limit: 200, tpm_limit: null, context_window: 131072, enabled: 1, supports_streaming: 1, supports_tools: 0, supports_vision: 0, supports_structured_output: 0, supports_reasoning: 0, priority: 6, source: 'catalog' },
      { id: 24, provider_id: 1, platform: 'google', model_id: 'gemma-4-26b-a4b-it', canonical_name: 'gemma-4-26b', display_name: 'Gemma 4 26B', intelligence_rank: 5, speed_rank: 5, size_label: 'Medium', rpm_limit: 15, rpd_limit: 1000, tpm_limit: 250000, context_window: 131072, enabled: 1, supports_streaming: 1, supports_tools: 0, supports_vision: 0, supports_structured_output: 0, supports_reasoning: 0, priority: 6, source: 'catalog' },
      { id: 25, provider_id: 2, platform: 'groq', model_id: 'groq/compound-mini', canonical_name: 'compound-mini', display_name: 'Compound Mini (Groq)', intelligence_rank: 18, speed_rank: 2, size_label: 'Medium', rpm_limit: 30, rpd_limit: 1000, tpm_limit: 8000, context_window: 131072, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 0, priority: 6, source: 'catalog' },
      { id: 26, provider_id: 2, platform: 'groq', model_id: 'groq/compound', canonical_name: 'compound', display_name: 'Compound (Groq)', intelligence_rank: 16, speed_rank: 2, size_label: 'Medium', rpm_limit: 30, rpd_limit: 1000, tpm_limit: 8000, context_window: 131072, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 0, supports_structured_output: 1, supports_reasoning: 0, priority: 6, source: 'catalog' },
      { id: 27, provider_id: 6, platform: 'github', model_id: 'gpt-4o', canonical_name: 'gpt-4o', display_name: 'GPT-4o (GitHub)', intelligence_rank: 20, speed_rank: 7, size_label: 'Large', rpm_limit: 10, rpd_limit: 50, tpm_limit: null, context_window: 128000, enabled: 1, supports_streaming: 1, supports_tools: 1, supports_vision: 1, supports_structured_output: 1, supports_reasoning: 0, priority: 20, source: 'catalog' },
    ];
    tables.get('models')!.push(...rawModels);
  }

  if (tables.get('quirks')!.length === 0) {
    const quirksData = [
      { id: 1, slug: 'keyless-anonymous', title: 'No API key required', body: 'Routes anonymously — the catalog ships a keyless sentinel row and calls work with no account or key.', severity: 'info', created_at_ms: 1700000000000, updated_at_ms: 1700000000000 },
      { id: 2, slug: 'ovh-anon-trickle', title: 'Anonymous tier is 2 req/min', body: 'OVH AI Endpoints anonymous mode is documented at 2 req/min per IP per model (observed even stricter across models). The 400 req/min authenticated tier requires a Public Cloud project with a payment method, so the catalog ships the keyless path. Treat as a breadth/fallback tier, not a throughput tier.', severity: 'warning', created_at_ms: 1700000000000, updated_at_ms: 1700000000000 },
      { id: 3, slug: 'pollinations-degraded', title: 'Publishable key uses recurring shared capacity', body: 'Pollinations chat uses https://gen.pollinations.ai/v1 with a free publishable API key. Shared free capacity currently accrues at one pollen per IP per hour; the legacy text host is no longer used.', severity: 'warning', created_at_ms: 1700000000000, updated_at_ms: 1700000000000 },
      { id: 4, slug: 'or-free-cap-account-wide', title: 'Daily :free cap is account-wide', body: 'OpenRouter’s :free daily cap (50/day, or 1000/day once you have ever bought $10 of credits) is shared across ALL :free models on the account, not per model. Per-row rpd values here are therefore optimistic; the router’s cooldown handling absorbs the shared 429s.', severity: 'info', created_at_ms: 1700000000000, updated_at_ms: 1700000000000 },
      { id: 5, slug: 'zen-promo-roster', title: 'Limited-time promo, roster rotates', body: 'OpenCode Zen free models are explicitly limited-time promotional access ("available for a limited time" per the docs), not a recurring quota. The roster rotates: qwen3.6-plus and minimax-m3 promos already ended. Expect any row here to die without notice; prompts/outputs may be used for model improvement.', severity: 'warning', created_at_ms: 1700000000000, updated_at_ms: 1700000000000 },
      { id: 6, slug: 'cloudflare-key-format', title: 'Key is account_id:token', body: 'Cloudflare Workers AI authenticates with a combined credential in the form "account_id:token", not a bare token.', severity: 'info', created_at_ms: 1700000000000, updated_at_ms: 1700000000000 },
      { id: 7, slug: 'nvidia-rate-limited', title: 'Recurring free, 40 RPM, eval-only ToS', body: 'NVIDIA NIM replaced its depleting trial credits with a recurring per-account rate limit (40 RPM default, varies by model), verified June 2026. The trial ToS still scopes usage to evaluation/prototyping, not production.', severity: 'info', created_at_ms: 1700000000000, updated_at_ms: 1700000000000 },
      { id: 8, slug: 'nim-gemma-hung', title: 'NIM gemma route hangs', body: 'The NVIDIA NIM gemma endpoint is listed but hangs (capacity starvation plus an upstream FlashAttention bug). Paused; probe with a 120s timeout before re-enabling.', severity: 'blocker', created_at_ms: 1700000000000, updated_at_ms: 1700000000000 },
      { id: 9, slug: 'or-ultra-hangs', title: 'OpenRouter ultra route hangs', body: 'nemotron-3-ultra (550B) on OpenRouter takes 180s+ even on trivial prompts (heavily congested), so its OR row is seeded disabled. Use the OpenCode Zen route instead.', severity: 'warning', created_at_ms: 1700000000000, updated_at_ms: 1700000000000 },
      { id: 10, slug: 'zen-serves-ultra-fast', title: 'Zen serves the 550B fast', body: 'OpenCode Zen serves nemotron-3-ultra in ~2s with working tool calls where the OpenRouter route hangs — the live-verified path for this model.', severity: 'info', created_at_ms: 1700000000000, updated_at_ms: 1700000000000 },
      { id: 11, slug: 'zhipu-shared-key', title: 'Works with existing Zhipu key', body: 'glm-4.6v-flash is listed Free on Z.AI and answers 200 with the existing bigmodel.cn key; vision and structured tool calls both live-verified.', severity: 'info', created_at_ms: 1700000000000, updated_at_ms: 1700000000000 },
    ];
    tables.get('quirks')!.push(...quirksData);

    const targetsData = [
      { id: 1, quirk_id: 1, platform: 'kilo', model_glob: null },
      { id: 2, quirk_id: 1, platform: 'llm7', model_glob: null },
      { id: 3, quirk_id: 1, platform: 'ovh', model_glob: null },
      { id: 4, quirk_id: 2, platform: 'ovh', model_glob: null },
      { id: 5, quirk_id: 3, platform: 'pollinations', model_glob: null },
      { id: 6, quirk_id: 4, platform: 'openrouter', model_glob: '*:free' },
      { id: 7, quirk_id: 5, platform: 'opencode', model_glob: null },
      { id: 8, quirk_id: 6, platform: 'cloudflare', model_glob: null },
      { id: 9, quirk_id: 7, platform: 'nvidia', model_glob: null },
      { id: 10, quirk_id: 8, platform: 'nvidia', model_glob: '*gemma*' },
      { id: 11, quirk_id: 9, platform: 'openrouter', model_glob: '*nemotron-3-ultra*' },
      { id: 12, quirk_id: 10, platform: 'opencode', model_glob: '*nemotron-3-ultra*' },
      { id: 13, quirk_id: 11, platform: 'zhipu', model_glob: '*glm-4.6v*' },
    ];
    tables.get('quirk_targets')!.push(...targetsData);
  }

  // The chain position is a POSITION (1 = served first), not a quality score:
  // the router walks the chain `ORDER BY priority ASC` and catalog-sync
  // appends a newly seen model at `MAX(priority) + 1` — i.e. at the END.
  // `models.priority` is the opposite scale (the seed gives the flagship
  // models 10 and the weaker ones 3), so copying it verbatim served the worst
  // model first. Rank the models instead: highest quality first, dense
  // positions 1..N. Migration 009 does the same for a real database.
  const chainOrder = () => {
    const rawModels = tables.get('models') || [];
    return [...rawModels].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id - b.id);
  };

  if (tables.get('fallback_config')!.length === 0) {
    const fb = chainOrder().map((m, i) => ({
      id: i + 1,
      model_db_id: m.id,
      priority: i + 1,
      enabled: 1,
    }));
    tables.get('fallback_config')!.push(...fb);
  }

  if (tables.get('profiles')!.length === 0) {
    tables.get('profiles')!.push({
      id: 1,
      name: 'Default',
      emoji: '⚙️',
      color: '#6366f1',
      type: 'default',
      sort_order: -1,
      auto_include_new_models: 1,
    });
  }

  if (tables.get('profile_models')!.length === 0) {
    const pm = chainOrder().map((m, i) => ({
      id: i + 1,
      profile_id: 1,
      model_db_id: m.id,
      priority: i + 1,
      enabled: 1,
    }));
    tables.get('profile_models')!.push(...pm);
  }

  if (tables.get('embedding_models') && tables.get('embedding_models')!.length === 0) {
    const rawEmbeddings = [
      { id: 1, family: 'gemini-embedding-001', platform: 'google', model_id: 'gemini-embedding-001', display_name: 'Gemini Embedding', dimensions: 3072, max_input_tokens: 2048, priority: 1, enabled: 1, quota_label: '100 rpm · 1K req/day' },
      { id: 2, family: 'llama-nemotron-embed-vl-1b-v2', platform: 'nvidia', model_id: 'nvidia/llama-nemotron-embed-vl-1b-v2', display_name: 'Nemotron Embed VL 1B', dimensions: 2048, max_input_tokens: 8192, priority: 1, enabled: 1, quota_label: '~40 rpm' },
      { id: 3, family: 'llama-nemotron-embed-vl-1b-v2', platform: 'openrouter', model_id: 'nvidia/llama-nemotron-embed-vl-1b-v2', display_name: 'Nemotron Embed VL 1B (OR)', dimensions: 2048, max_input_tokens: 8192, priority: 2, enabled: 1, quota_label: '$0/M tok' },
      { id: 4, family: 'llama-nemotron-embed-1b-v2', platform: 'nvidia', model_id: 'nvidia/llama-nemotron-embed-1b-v2', display_name: 'Nemotron Embed 1B', dimensions: 2048, max_input_tokens: 8192, priority: 1, enabled: 1, quota_label: '~40 rpm' },
      { id: 5, family: 'nv-embedqa-e5-v5', platform: 'nvidia', model_id: 'nvidia/nv-embedqa-e5-v5', display_name: 'NV-EmbedQA E5 v5', dimensions: 1024, max_input_tokens: 512, priority: 1, enabled: 1, quota_label: '~40 rpm' },
      { id: 6, family: 'text-embedding-3-small', platform: 'github', model_id: 'openai/text-embedding-3-small', display_name: 'Text Embedding 3 Small', dimensions: 1536, max_input_tokens: 8191, priority: 1, enabled: 1, quota_label: 'rate-limited free' },
      { id: 7, family: 'text-embedding-3-large', platform: 'github', model_id: 'openai/text-embedding-3-large', display_name: 'Text Embedding 3 Large', dimensions: 3072, max_input_tokens: 8191, priority: 1, enabled: 1, quota_label: 'rate-limited free' },
      { id: 8, family: 'bge-m3', platform: 'cloudflare', model_id: '@cf/baai/bge-m3', display_name: 'BGE-M3', dimensions: 1024, max_input_tokens: 8192, priority: 1, enabled: 1, quota_label: '10K neurons/day (shared)' },
      { id: 9, family: 'bge-m3', platform: 'huggingface', model_id: 'BAAI/bge-m3', display_name: 'BGE-M3 (HF)', dimensions: 1024, max_input_tokens: 8192, priority: 2, enabled: 1, quota_label: '$0.10/mo credits' },
      { id: 10, family: 'embeddinggemma-300m', platform: 'cloudflare', model_id: '@cf/google/embeddinggemma-300m', display_name: 'EmbeddingGemma 300M', dimensions: 768, max_input_tokens: 2048, priority: 1, enabled: 1, quota_label: '10K neurons/day (shared)' },
      { id: 11, family: 'qwen3-embedding-0.6b', platform: 'cloudflare', model_id: '@cf/qwen/qwen3-embedding-0.6b', display_name: 'Qwen3 Embedding 0.6B', dimensions: 1024, max_input_tokens: 4096, priority: 1, enabled: 1, quota_label: '10K neurons/day (shared)' },
      { id: 12, family: 'embed-v4.0', platform: 'cohere', model_id: 'embed-v4.0', display_name: 'Cohere Embed v4', dimensions: 1536, max_input_tokens: 128000, priority: 1, enabled: 0, quota_label: '1K calls/mo (shared w/ chat)' },
    ];
    tables.get('embedding_models')!.push(...rawEmbeddings);
  }

  if (tables.get('settings')!.length === 0 || !tables.get('settings')!.some(s => s.key === 'active_profile_id')) {
    tables.get('settings')!.push({ key: 'active_profile_id', value: '1' });
  }

  if (!tables.get('settings')!.some(s => s.key === 'embeddings_default_family')) {
    tables.get('settings')!.push({ key: 'embeddings_default_family', value: 'gemini-embedding-001' });
  }
}

/**
 * In-memory mock pool for running unit tests without an active live Postgres daemon.
 */
function createInMemoryMockPool(storageKey?: string) {
  let isClosed = false;
  let tables: Map<string, any[]>;
  if (storageKey) {
    if (!mockPoolStorage.has(storageKey)) {
      mockPoolStorage.set(storageKey, new Map<string, any[]>());
    }
    tables = mockPoolStorage.get(storageKey)!;
  } else {
    tables = new Map<string, any[]>();
  }
  
  // Initialize standard tables if not already present
  const standardTables = [
    'providers', 'credentials', 'models', 'routing_configuration',
    'analytics_hourly', 'settings', 'url_tokens', 'client_profiles',
    'playground_conversations', 'migrations', 'users', 'sessions',
    'rate_limit_cooldowns', 'rate_limit_usage', 'media_models',
    'api_keys', 'requests', 'profiles', 'profile_models', 'fallback_config',
    'embedding_models', 'custom_model_tombstones', 'catalog_model_tombstones',
    'quirks', 'quirk_targets', 'provider_quota_observations',
    'provider_quota_state', 'response_cache', 'idempotency_claims',
    'server_logs', 'backups', 'search_requests', 'request_attempts'
  ];
  for (const name of standardTables) {
    if (!tables.has(name)) {
      tables.set(name, []);
    }
  }

  seedMockDatabase(tables);

  let idCounter = 100;

  // SELECT shapes the hand-written branches below understand (joins, group-bys
  // and point lookups with bespoke return shapes). Anything else — including
  // every table restored by 006_compat_tables — belongs to the SQL engine so
  // the mock reads the REAL table. Falling through to `providers` returned
  // the wrong rows with a straight face.
  const specialSelectTable = (upper: string): string | null => {
    if (upper.includes('FROM MIGRATIONS')) return 'migrations';
    if (upper.includes('FROM USERS')) return 'users';
    if (upper.includes('FROM SESSIONS')) return 'sessions';
    if (upper.includes('FROM SETTINGS')) return 'settings';
    if (upper.includes('FROM CREDENTIALS')) return 'credentials';
    if (upper.includes('FROM MODELS')) return 'models';
    if (upper.includes('FROM ROUTING_CONFIGURATION')) return 'routing_configuration';
    if (upper.includes('FROM ANALYTICS_HOURLY')) return 'analytics_hourly';
    if (upper.includes('FROM CLIENT_PROFILES')) return 'client_profiles';
    if (upper.includes('FROM RATE_LIMIT_COOLDOWNS')) return 'rate_limit_cooldowns';
    if (upper.includes('FROM RATE_LIMIT_USAGE')) return 'rate_limit_usage';
    if (upper.includes('FROM URL_TOKENS')) return 'url_tokens';
    return null;
  };

  // Aggregates over a filtered set: only the SQL engine binds $n/? through the
  // WHERE. The hand-written point-lookup branches would answer the whole
  // table (or undefined) for a filtered COUNT — a silent wrong answer.
  const aggregateViaEngine = (trimmed: string, params: any[]) => {
    if (/\bJOIN\b/i.test(trimmed)) return null;
    if (/SELECT\s+(?:DISTINCT\s+)?(?:COUNT|SUM|AVG|MAX|MIN|COALESCE)\s*\(/i.test(trimmed)) {
      return execStatement(tables, trimmed, params, nextId);
    }
    return null;
  };

  const mockQuery = async (text: string, params: any[] = []): Promise<QueryResult<any>> => {
    const trimmed = text.trim();
    const upper = trimmed.toUpperCase();

    if (upper.startsWith('SELECT 1')) {
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }

    if (upper.startsWith('BEGIN') || upper.startsWith('COMMIT') || upper.startsWith('ROLLBACK')) {
      return { rows: [], rowCount: 0 };
    }

    if (upper.startsWith('CREATE TABLE') || upper.startsWith('CREATE INDEX') || upper.startsWith('ALTER TABLE')) {
      return { rows: [], rowCount: 0 };
    }

    if (upper.startsWith('SELECT')) {
      const special = specialSelectTable(upper);
      if (!special) {
        const generic = execStatement(tables, trimmed, params, nextId);
        if (generic) return { rows: generic.rows ?? [], rowCount: generic.rows?.length ?? 0 };
        return { rows: [], rowCount: 0 };
      }
      const tableName = special;

      const viaAggregate = aggregateViaEngine(trimmed, params);
      if (viaAggregate) return { rows: viaAggregate.rows ?? [], rowCount: viaAggregate.rows?.length ?? 0 };

      const rows = tables.get(tableName) || [];

      // `userCount()` (auth service) asks for COUNT(*); the generic fallback
      // returns the raw rows, and `rows[0].c` would then read as 0 users
      // forever — which would let a declarative `admin` entry re-provision an
      // install that already has an account.
      if (tableName === 'users' && /COUNT\(\*\)\s+AS\s+C\b/i.test(trimmed)) {
        return { rows: [{ c: String(rows.length) }], rowCount: 1 };
      }

      if (upper.includes('FROM CREDENTIALS C') && upper.includes('JOIN PROVIDERS P')) {
        const creds = tables.get('credentials') || [];
        const provs = tables.get('providers') || [];
        let joined = creds
          .map(c => {
            const p = provs.find(pr => Number(pr.id) === Number(c.provider_id));
            return { credential: c, provider: p };
          })
          .filter(j => j.provider != null);

        if (upper.includes('WHERE C.ID = $1') || upper.includes('WHERE C.ID = ?') || upper.includes('WHERE ID = $1') || upper.includes('WHERE ID = ?')) {
          const targetId = Number(params[0]);
          joined = joined.filter(j => Number(j.credential.id) === targetId);
        } else if (upper.includes('AND C.ENABLED = TRUE') || upper.includes('WHERE C.ENABLED = TRUE')) {
          joined = joined.filter(j => j.credential.enabled !== false && j.credential.enabled !== 0);
        }

        if (upper.includes('COUNT(*) AS ENABLED_KEYS')) {
          if (upper.includes('GROUP BY P.PROVIDER_KEY')) {
            const map = new Map<string, { platform: string; enabled_keys: number; healthy_keys: number; unknown_keys: number; invalid_keys: number; error_keys: number }>();
            for (const j of joined) {
              const platform = j.provider.provider_key;
              if (!map.has(platform)) {
                map.set(platform, { platform, enabled_keys: 0, healthy_keys: 0, unknown_keys: 0, invalid_keys: 0, error_keys: 0 });
              }
              const entry = map.get(platform)!;
              entry.enabled_keys += 1;
              if (!j.credential.last_health_error) {
                entry.healthy_keys += 1;
              } else {
                entry.invalid_keys += 1;
              }
            }
            return { rows: Array.from(map.values()), rowCount: map.size };
          }
          const healthy = joined.filter(j => !j.credential.last_health_error);
          return {
            rows: [{
              enabled_keys: joined.length,
              ready_upstreams: new Set(healthy.map(j => j.provider.provider_key)).size,
            }],
            rowCount: 1,
          };
        }

        const now = Date.now();
        const mapped = joined.map(j => {
          const c = j.credential;
          const p = j.provider;
          const raw = c.last_checked_at;
          const lastChecked = raw ? (raw instanceof Date ? raw.getTime() : new Date(typeof raw === 'string' && !raw.endsWith('Z') && !raw.includes('+') ? raw.replace(' ', 'T') + 'Z' : raw).getTime()) : null;
          const age_ms = lastChecked !== null && !isNaN(lastChecked) ? Math.max(0, now - lastChecked) : null;
          return {
            ...c,
            id: c.id,
            platform: p.provider_key,
            base_url: c.base_url !== undefined ? c.base_url : (p.base_url || null),
            enabled: Boolean(c.enabled),
            status: c.status || 'unknown',
            last_health_error: c.last_health_error || null,
            cooldown_until: c.cooldown_until || null,
            age_ms,
          };
        });
        return { rows: mapped, rowCount: mapped.length };
      }

      if (tableName === 'rate_limit_cooldowns' && upper.includes('WHERE PLATFORM =')) {
        const matched = rows.find(r => r.platform === params[0] && r.model_id === params[1] && Number(r.key_id) === Number(params[2]));
        return { rows: matched ? [matched] : [], rowCount: matched ? 1 : 0 };
      }

      if (tableName === 'requests') {
        const generic = execStatement(tables, trimmed, params, nextId);
        if (generic) return { rows: generic.rows ?? [], rowCount: generic.rows?.length ?? 0 };
      }

      if (upper.includes('COUNT(')) {
        return { rows: [{ count: String(rows.length), c: String(rows.length) }], rowCount: 1 };
      }

      if (tableName === 'models') {
        let matched = [...rows];
        if (upper.includes('WHERE PLATFORM =') && upper.includes('MODEL_ID =')) {
          matched = matched.filter(r => (r.platform === params[0] || Number(r.provider_id) === Number(params[0])) && r.model_id === params[1]);
          return { rows: matched, rowCount: matched.length };
        }
        if (upper.includes('WHERE MODEL_ID =')) {
          const val = params[0];
          matched = matched.filter(r => r.model_id === val);
          return { rows: matched, rowCount: matched.length };
        }
        if (upper.includes('WHERE PROVIDER_ID =')) {
          const val = Number(params[0]);
          matched = matched.filter(r => Number(r.provider_id) === val);
          return { rows: matched, rowCount: matched.length };
        }
      }

      if (tableName === 'providers' && upper.includes('WHERE PROVIDER_KEY =')) {
        const keyVal = params.length > 0 ? params[0] : upper.match(/WHERE PROVIDER_KEY\s*=\s*'([^']+)'/i)?.[1]?.toLowerCase();
        const matched = rows.filter(r => r.provider_key?.toLowerCase() === keyVal);
        return { rows: matched, rowCount: matched.length };
      }
      if (/WHERE\s+(?:[A-Za-z_][\w]*\.)?id\s*=\s*(?:\$1|\?)/i.test(upper)) {
        const matched = rows.filter(r => Number(r.id) === Number(params[0]));
        return { rows: matched, rowCount: matched.length };
      }
      if (tableName === 'users' && upper.includes('WHERE EMAIL = $1')) {
        const matched = rows.filter(r => r.email === params[0]);
        return { rows: matched, rowCount: matched.length };
      }
      if (tableName === 'sessions') {
        const generic = execStatement(tables, trimmed, params, nextId);
        if (generic) return { rows: generic.rows ?? [], rowCount: generic.rows?.length ?? 0 };
        if (upper.includes('TOKEN_HASH')) {
          const users = tables.get('users') || [];
          const matched = rows
            .filter(r => r.token_hash === params[0])
            .map(s => {
              const u = users.find(user => user.id === s.user_id);
              return { user_id: s.user_id, expires_at_ms: s.expires_at_ms, email: u?.email ?? '' };
            });
          return { rows: matched, rowCount: matched.length };
        }
      }
      if (tableName === 'settings') {
        const generic = execStatement(tables, trimmed, params, nextId);
        if (generic) return { rows: generic.rows ?? [], rowCount: generic.rows?.length ?? 0 };
        const keyMatch = trimmed.match(/WHERE\s+KEY\s*=\s*(?:'([^']+)'|\$1|\?)/i);
        if (keyMatch) {
          const targetKey = keyMatch[1] !== undefined ? keyMatch[1] : String(params[0] ?? '');
          const matched = rows.filter(r => String(r.key ?? '').toLowerCase() === targetKey.toLowerCase());
          return { rows: matched, rowCount: matched.length };
        }
      }

      if (tableName === 'url_tokens' && upper.includes('WHERE TOKEN_HASH = $1')) {
        const rows = tables.get('url_tokens') || [];
        const matched = rows.filter(r => r.token_hash === params[0] && r.revoked_at == null);
        return { rows: matched, rowCount: matched.length };
      }

      return { rows: [...rows], rowCount: rows.length };
    }

    if (upper.startsWith('INSERT INTO') && (upper.includes('ON CONFLICT') || upper.startsWith('INSERT INTO SETTINGS') || upper.startsWith('INSERT INTO KEY_MONTHLY_USAGE'))) {
      const generic = execStatement(tables, trimmed, params, nextId);
      if (generic) return { rows: generic.rows ?? [], rowCount: generic.changes ?? 1 };
    }

    if (upper.startsWith('INSERT INTO')) {
      const match = trimmed.match(/INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
      if (match) {
        const tableName = match[1].toLowerCase();
        const cols = match[2].split(',').map(c => c.trim().toLowerCase());
        const vals = match[3].split(',').map(v => v.trim());
        const rows = tables.get(tableName) || [];
        const record: any = { id: idCounter++, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), applied_at: new Date().toISOString() };

        cols.forEach((col, i) => {
          const valExpr = vals[i];
          if (valExpr && valExpr.startsWith('$')) {
            const paramIdx = parseInt(valExpr.substring(1), 10) - 1;
            record[col] = params[paramIdx];
          } else if (valExpr && (valExpr.startsWith("'") || valExpr.startsWith('"'))) {
            record[col] = valExpr.slice(1, -1);
          } else if (valExpr === 'true' || valExpr === 'TRUE') {
            record[col] = true;
          } else if (valExpr === 'false' || valExpr === 'FALSE') {
            record[col] = false;
          } else if (valExpr && !isNaN(Number(valExpr))) {
            record[col] = Number(valExpr);
          } else {
            record[col] = params[i];
          }
        });
        if (record.enabled === undefined) record.enabled = true;
        // The real schema makes `users.email` unique; without the same refusal
        // here a duplicate dashboard account would silently be created in tests.
        if (tableName === 'users' && rows.some(r => r.email === record.email)) {
          const dup: any = new Error('duplicate key value violates unique constraint "users_email_key"');
          dup.code = '23505';
          throw dup;
        }
        rows.push(record);
        tables.set(tableName, rows);

        if (tableName === 'requests' && record.key_id != null && record.status === 'success') {
          const month = typeof record.created_at === 'string' && record.created_at.length >= 7
            ? record.created_at.slice(0, 7)
            : new Date().toISOString().slice(0, 7);
          const addedTokens = Math.max(0, Number(record.input_tokens) || 0) + Math.max(0, Number(record.output_tokens) || 0);
          const kmRows = tables.get('key_monthly_usage') || [];
          const existing = kmRows.find((r: any) => Number(r.key_id) === Number(record.key_id) && r.month === month);
          if (existing) {
            existing.requests = (Number(existing.requests) || 0) + 1;
            existing.tokens = (Number(existing.tokens) || 0) + addedTokens;
          } else {
            kmRows.push({
              id: idCounter++,
              key_id: Number(record.key_id),
              month,
              requests: 1,
              tokens: addedTokens,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            tables.set('key_monthly_usage', kmRows);
          }
        }

        return { rows: [record], rowCount: 1 };
      }
    }

    if (upper.startsWith('UPDATE URL_TOKENS')) {
      const rows = tables.get('url_tokens') || [];
      const idMatch = upper.match(/WHERE\s+ID\s*=\s*\$(\d+)/);
      const id = idMatch ? Number(params[Number(idMatch[1]) - 1]) : NaN;
      const now = new Date().toISOString();
      let changed = 0;
      for (const row of rows) {
        if (Number(row.id) !== id) continue;
        if (upper.includes('REVOKED_AT') && row.revoked_at != null) continue;
        if (upper.includes('REVOKED_AT')) row.revoked_at = now;
        if (upper.includes('LAST_USED_AT')) row.last_used_at = now;
        changed += 1;
      }
      return { rows: [], rowCount: changed };
    }


    if (upper.startsWith('UPDATE')) {
      const generic = execStatement(tables, trimmed, params, nextId);
      return { rows: generic?.rows ?? [], rowCount: generic?.changes ?? 1 };
    }

    if (upper.startsWith('DELETE FROM MODELS')) {
      const rows = tables.get('models') || [];
      if (params.length > 0) {
        const id = params[0];
        const filtered = rows.filter(r => Number(r.id) !== Number(id));
        tables.set('models', filtered);
        return { rows: [], rowCount: rows.length - filtered.length };
      }
      tables.set('models', []);
      return { rows: [], rowCount: rows.length };
    }

    if (upper.startsWith('DELETE FROM CREDENTIALS')) {
      const rows = tables.get('credentials') || [];
      tables.set('credentials', []);
      return { rows: [], rowCount: rows.length };
    }

    if (upper.startsWith('DELETE FROM PROVIDERS')) {
      const rows = tables.get('providers') || [];
      tables.set('providers', []);
      return { rows: [], rowCount: rows.length };
    }

    if (upper.startsWith('DELETE')) {
      const generic = execStatement(tables, trimmed, params, nextId);
      return { rows: generic?.rows ?? [], rowCount: generic?.changes ?? 1 };
    }

    // Anything the hand-written branches above do not recognise: hand it to the
    // small SQL engine, which covers the tables restored by 006_compat_tables
    // and anything else the code writes with plain statements. Without this the
    // mock answered "no rows" for every table the migration had not recreated,
    // which is how those code paths stayed broken and unnoticed.
    const generic = execStatement(tables, trimmed, params, nextId);
    if (generic) return { rows: generic.rows ?? [], rowCount: generic.changes || generic.rows?.length || 0 };

    return { rows: [], rowCount: 0 };
  };

  const nextId = () => idCounter++;

  return {
    query: (text: string, params?: any[]) => {
      if (isClosed) throw new Error('Database is closed');
      return mockQuery(text, params);
    },
    connect: async () => {
      if (isClosed) throw new Error('Database is closed');
      return {
        query: mockQuery,
        release: () => {},
      };
    },
    on: () => {},
    end: async () => {
      isClosed = true;
      pool = null;
    },
    // The Db interface declares close(); tests tear down via getDb().close().
    // pg.Pool uses end(), so expose close() as an alias on the mock too.
    close: async () => {
      isClosed = true;
      pool = null;
    },
    prepare: (sql: string) => {
      if (isClosed) throw new Error('Database is closed');
      return {
      get: (...args: any[]) => {
        if (isClosed) throw new Error('Database is closed');
        const u = sql.toUpperCase();
        // Aggregates belong to the SQL engine: the point-lookup branches below
        // answer `undefined` (or a raw row) where the caller reads `.n`.
        if (/SELECT\s+(?:DISTINCT\s+)?(?:COUNT|SUM|AVG|MAX|MIN|COALESCE)\s*\(/i.test(u)) {
          const generic = execStatement(tables, sql, args, nextId);
          if (generic) return generic.rows?.[0];
        }
        if (u.includes('FROM RATE_LIMIT_COOLDOWNS')) {
          const generic = execStatement(tables, sql, args, nextId);
          if (generic && generic.rows?.[0]) return generic.rows[0];
          const rows = tables.get('rate_limit_cooldowns') || [];
          return rows.find(r => r.platform === args[0] && r.model_id === args[1] && Number(r.key_id) === Number(args[2]));
        }
        if (u.includes('FROM MODELS')) {
          const generic = execStatement(tables, sql, args, nextId);
          if (generic) return generic.rows?.[0];
          const rows = tables.get('models') || [];
          if (u.includes('WHERE PLATFORM = ? AND MODEL_ID = ?') || u.includes('WHERE PLATFORM =') && u.includes('MODEL_ID =')) {
            const pKey = args[0];
            const mId = args[1];
            return rows.find(r => (r.platform === pKey || Number(r.provider_id) === Number(pKey)) && r.model_id === mId);
          }
          if (u.includes('WHERE MODEL_ID = ?')) {
            const mId = args[0];
            return rows.find(r => r.model_id === mId);
          }
          return undefined;
        }
        if (u.includes('FROM CLIENT_PROFILES')) {
          const rows = tables.get('client_profiles') || [];
          if (u.includes('TOKEN_HASH = ?')) {
            return rows.find(r => r.token_hash === args[0]);
          }
          return rows[0];
        }
        if (u.includes('FROM SETTINGS')) {
          const generic = execStatement(tables, sql, args, nextId);
          if (generic) return generic.rows?.[0];
          const rows = tables.get('settings') || [];
          const keyMatch = sql.match(/WHERE\s+KEY\s*=\s*(?:'([^']+)'|\$1|\?)/i);
          if (keyMatch) {
            const target = keyMatch[1] !== undefined ? keyMatch[1] : String(args[0] ?? '');
            return rows.find(r => String(r.key ?? '').toLowerCase() === target.toLowerCase());
          }
          return rows[0];
        }
        if (u.includes('FROM API_KEYS')) {
          const generic = execStatement(tables, sql, args, nextId);
          if (generic) return generic.rows?.[0];
          const rows = tables.get('api_keys') || [];
          if (u.includes('WHERE ID = ?')) {
            return rows.find(r => Number(r.id) === Number(args[0]));
          }
          if (u.includes('WHERE PLATFORM = ?')) {
            return rows.find(r => r.platform === args[0] && r.enabled !== 0 && r.enabled !== false);
          }
          return rows[0];
        }
        if (u.includes('FROM REQUESTS')) {
          const generic = execStatement(tables, sql, args, nextId);
          return generic?.rows?.[0];
        }
        // Not one of the hand-written shapes above: run it for real. This is
        // what makes the tables restored by 006_compat_tables usable in tests
        // instead of silently answering "no rows".
        const generic = execStatement(tables, sql, args, nextId);
        if (generic) return generic.rows?.[0];
        return undefined;
      },
      all: (...args: any[]) => {
        const u = sql.toUpperCase();
        const argList = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
        // Aggregates belong to the SQL engine, which returns {n: ...} — the
        // hand-written branches below answer raw rows for COUNT queries.
        if (/SELECT\s+(?:DISTINCT\s+)?(?:COUNT|SUM|AVG|MAX|MIN|COALESCE)\s*\(/i.test(u)) {
          const generic = execStatement(tables, sql, argList, nextId);
          if (generic) return generic.rows ?? [];
        }
        if (u.includes('FROM CLIENT_PROFILES')) {
          return tables.get('client_profiles') || [];
        }
        if (u.includes('FROM SETTINGS')) {
          if (u.includes('WHERE')) {
            const generic = execStatement(tables, sql, argList, nextId);
            if (generic) return generic.rows ?? [];
          }
          return tables.get('settings') || [];
        }
        if (u.includes('FROM MEDIA_MODELS')) {
          const generic = execStatement(tables, sql, argList, nextId);
          if (generic) return generic.rows ?? [];
          return tables.get('media_models') || [];
        }
        if (u.includes('FROM REQUESTS')) {
          const generic = execStatement(tables, sql, argList, nextId);
          if (generic) return generic.rows ?? [];
        }
        // Not one of the hand-written shapes above: run it for real, so the
        // tables restored by 006_compat_tables actually return their rows.
        const generic = execStatement(tables, sql, argList, nextId);
        if (generic) return generic.rows ?? [];
        return [];
      },
      run: (...args: any[]) => {
        const u = sql.toUpperCase();
        if (u.includes('INSERT INTO CLIENT_PROFILES')) {
          const rows = tables.get('client_profiles') || [];
          const record = {
            id: idCounter++,
            name: args[0],
            token_hash: args[1],
            encrypted_key: args[2],
            iv: args[3],
            auth_tag: args[4],
            system_prompt: args[5] || null,
            enabled: args[6] !== false && args[6] !== 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          rows.push(record);
          tables.set('client_profiles', rows);
          return { changes: 1, lastInsertRowid: record.id };
        }
        if (u.includes('INSERT INTO API_KEYS')) {
          const generic = execStatement(tables, sql, args, nextId);
          if (generic) {
            const apiKeys = tables.get('api_keys') || [];
            const record = apiKeys[apiKeys.length - 1];
            if (record) {
              const provs = tables.get('providers') || [];
              let prov = provs.find(p => p.provider_key === record.platform);
              if (!prov) {
                prov = { id: idCounter++, provider_key: record.platform, display_name: record.platform, enabled: true };
                provs.push(prov);
              }
              const creds = tables.get('credentials') || [];
              // The mirror must carry the columns the real `credentials` table
              // has that the readers rely on. A row without `created_at` makes
              // GET /api/keys throw `RangeError: Invalid time value` on
              // `new Date(row.created_at)` and answer 500 — a mock that lies
              // about Postgres.
              //
              // Only the columns that are safe to add are listed: the mock's
              // WHERE evaluation treats a missing column as "never matches",
              // so adding a column whose value the query filters on (the
              // monthly caps, the cooldown, the model scope, the last failure)
              // CHANGES which rows a query returns. Those five stay absent for
              // now — see the open mock-fidelity item in the handover notes.
              const createdAt = record.created_at || nowIso();
              creds.push({
                id: record.id,
                provider_id: prov.id,
                credential_name: record.label || 'test',
                encrypted_value: record.encrypted_key,
                encrypted_key: record.encrypted_key,
                iv: record.iv,
                auth_tag: record.auth_tag,
                credential_type: record.credential_type || 'api_key',
                status: record.status || 'unknown',
                circuit_state: record.status === 'invalid' ? 'DISABLED' : 'HEALTHY',
                enabled: record.enabled !== 0 && record.enabled !== false && record.status !== 'invalid',
                priority: record.priority ?? 0,
                group_label: record.group_label ?? null,
                success_count: record.success_count ?? 0,
                failure_count: record.failure_count ?? 0,
                last_used_at: record.last_used_at ?? null,
                created_at: createdAt,
                updated_at: record.updated_at || createdAt,
                last_health_error: record.last_health_error !== undefined ? record.last_health_error : (record.status === 'invalid' ? 'Invalid credential' : null),
                base_url: record.base_url !== undefined ? record.base_url : null,
                last_checked_at: record.last_checked_at !== undefined ? record.last_checked_at : null,
                proxy_encrypted: record.proxy_encrypted || null,
                proxy_iv: record.proxy_iv || null,
                proxy_auth_tag: record.proxy_auth_tag || null,
              });
            }
            return { changes: generic.changes, lastInsertRowid: generic.lastInsertRowid };
          }
          return { changes: 1, lastInsertRowid: 1 };
        }

        if (u.includes('INSERT INTO MODELS') && !(args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]))) {
          const res = execStatement(tables, sql, args, nextId);
          if (res && res.changes > 0) {
            const models = tables.get('models') || [];
            const provs = tables.get('providers') || [];
            const inserted = models.find(m => m.id === res.lastInsertRowid);
            if (inserted) {
              if (inserted.platform && !inserted.provider_id) {
                let prov = provs.find(p => p.provider_key === inserted.platform);
                if (!prov) {
                  prov = { id: idCounter++, provider_key: inserted.platform, display_name: inserted.platform, enabled: true };
                  provs.push(prov);
                  tables.set('providers', provs);
                }
                inserted.provider_id = prov.id;
              }
              if (!inserted.canonical_name && inserted.model_id) {
                inserted.canonical_name = inserted.model_id;
              }
              if (inserted.supports_streaming === undefined) inserted.supports_streaming = true;
              if (inserted.supports_tools === undefined) inserted.supports_tools = true;
            }
            return res;
          }
          return res ?? { changes: 0, lastInsertRowid: 0 };
        }
        // Auth tables: test setup clears them between cases. Sessions go first
        // so a stale token can never outlive the account it belonged to.
        if (u.includes('DELETE FROM SESSIONS')) {
          const rows = tables.get('sessions') || [];
          tables.set('sessions', []);
          return { changes: rows.length, lastInsertRowid: 0 };
        }
        if (u.includes('DELETE FROM USERS')) {
          const rows = tables.get('users') || [];
          tables.set('users', []);
          return { changes: rows.length, lastInsertRowid: 0 };
        }
        if (u.startsWith('DELETE FROM API_KEYS')) {
          const res = execStatement(tables, sql, args, nextId);
          const apiKeys = tables.get('api_keys') || [];
          const remainingIds = new Set(apiKeys.map(k => Number(k.id)));
          const creds = tables.get('credentials') || [];
          tables.set('credentials', creds.filter(c => remainingIds.has(Number(c.id))));
          return res ?? { changes: 0, lastInsertRowid: 0 };
        }

        if (u.includes('UPDATE API_KEYS')) {
          const generic = execStatement(tables, sql, args, nextId);
          const apiKeys = tables.get('api_keys') || [];
          const creds = tables.get('credentials') || [];
          for (const ak of apiKeys) {
            const cred = creds.find(c => Number(c.id) === Number(ak.id));
            if (cred) {
              if (ak.status !== undefined) cred.status = ak.status;
              if (ak.enabled !== undefined) cred.enabled = ak.enabled !== 0 && ak.enabled !== false && ak.status !== 'invalid';
              if (ak.last_health_error !== undefined) cred.last_health_error = ak.last_health_error;
              if (ak.last_checked_at !== undefined) cred.last_checked_at = ak.last_checked_at;
              if (ak.base_url !== undefined) cred.base_url = ak.base_url;
              if (ak.proxy_encrypted !== undefined) cred.proxy_encrypted = ak.proxy_encrypted;
              if (ak.proxy_iv !== undefined) cred.proxy_iv = ak.proxy_iv;
              if (ak.proxy_auth_tag !== undefined) cred.proxy_auth_tag = ak.proxy_auth_tag;
            }
          }
          return { changes: generic?.changes ?? 1, lastInsertRowid: generic?.lastInsertRowid ?? 0 };
        }
        if (u.includes('UPDATE MODELS') && u.includes('PRIORITY')) {
          const res = execStatement(tables, sql, args, nextId);
          const models = tables.get('models') || [];
          const fb = tables.get('fallback_config') || [];
          for (const m of models) {
            const row = fb.find(f => Number(f.model_db_id) === Number(m.id));
            if (row && m.priority !== undefined) {
              row.priority = m.priority;
            }
          }
          return res ?? { changes: 1, lastInsertRowid: 0 };
        }
        // Not one of the hand-written shapes above: execute it for real, so the
        // writes against the tables restored by 006_compat_tables (and any
        // other plain INSERT/UPDATE/DELETE) take effect in tests.
        const generic = execStatement(tables, sql, args, nextId);
        if (generic) return { changes: generic.changes, lastInsertRowid: generic.lastInsertRowid };
        return { changes: 1, lastInsertRowid: 1 };
      },
    };
  },
    exec: (sql: string) => {
      if (isClosed) throw new Error('Database is closed');
      for (const stmt of sql.split(';')) {
        const trimmed = stmt.trim();
        if (trimmed) {
          execStatement(tables, trimmed, [], nextId);
        }
      }
    },
    transaction: (fn: any) => fn,
    pragma: () => [],
    isMock: () => true,
    _mockTables: tables,
  };
}
