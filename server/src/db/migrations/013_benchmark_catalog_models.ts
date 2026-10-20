import pg from 'pg';

// Forward migration for installations that already applied
// 002_seed_providers_models before the benchmark catalog models were added to
// it. An applied migration is immutable — editing 002 alone never reaches an
// existing database — so this backfills the same rows idempotently.
const BENCHMARK_MODELS = [
  { provider: 'groq', modelId: 'openai/gpt-oss-120b', canonical: 'gpt-oss-120b', name: 'GPT-OSS 120B (Groq)', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 6 },
  { provider: 'groq', modelId: 'openai/gpt-oss-20b', canonical: 'gpt-oss-20b', name: 'GPT-OSS 20B (Groq)', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 6 },
  { provider: 'groq', modelId: 'qwen/qwen3-32b', canonical: 'qwen3-32b', name: 'Qwen3 32B (Groq)', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 6 },
  { provider: 'openrouter', modelId: 'nousresearch/hermes-3-llama-3.1-405b:free', canonical: 'hermes-3', name: 'Hermes 3 (free)', ctx: 131072, maxOut: 8192, stream: true, tools: false, vision: false, structOut: false, reasoning: false, priority: 6 },
  { provider: 'google', modelId: 'gemma-4-26b-a4b-it', canonical: 'gemma-4-26b', name: 'Gemma 4 26B', ctx: 131072, maxOut: 8192, stream: true, tools: false, vision: false, structOut: false, reasoning: false, priority: 6 },
  { provider: 'groq', modelId: 'groq/compound-mini', canonical: 'compound-mini', name: 'Compound Mini (Groq)', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 6 },
  { provider: 'groq', modelId: 'groq/compound', canonical: 'compound', name: 'Compound (Groq)', ctx: 131072, maxOut: 8192, stream: true, tools: true, vision: false, structOut: true, reasoning: false, priority: 6 },
  { provider: 'github', modelId: 'gpt-4o', canonical: 'gpt-4o', name: 'GPT-4o (GitHub)', ctx: 128000, maxOut: 4096, stream: true, tools: true, vision: true, structOut: true, reasoning: false, priority: 20 },
];

export async function up(client: pg.PoolClient | pg.Pool): Promise<void> {
  for (const m of BENCHMARK_MODELS) {
    const prov = await client.query('SELECT id FROM providers WHERE provider_key = $1', [m.provider]);
    const providerId = prov.rows[0]?.id;
    if (!providerId) continue;
    await client.query(
      `INSERT INTO models (
         provider_id, platform, model_id, canonical_name, display_name, enabled,
         context_window, max_output_tokens, supports_streaming, supports_tools,
         supports_vision, supports_structured_output, supports_reasoning, priority
       )
       VALUES ($1, $2, $3, $4, $5, true, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (provider_id, model_id) DO NOTHING`,
      [providerId, m.provider, m.modelId, m.canonical, m.name, m.ctx, m.maxOut, m.stream, m.tools, m.vision, m.structOut, m.reasoning, m.priority]
    );
  }
}

export async function down(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query(
    `DELETE FROM models WHERE model_id IN (
       'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3-32b',
       'nousresearch/hermes-3-llama-3.1-405b:free', 'gemma-4-26b-a4b-it',
       'groq/compound-mini', 'groq/compound', 'gpt-4o'
     )`
  );
}
