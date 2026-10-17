import { getDb, getSetting, setSetting } from '../db/index.js';

// #1347 (PR 2): built-in per-key concurrency defaults, opt-in.
//
// With the setting off (the default) the behaviour is exactly today's:
// `getKeyConcurrencyLimit` consults only the MAX_CONCURRENT_REQUESTS_PER_KEY*
// env vars and returns null (unlimited) otherwise. With it on, a platform
// listed below falls back to its conservative built-in cap when no env var is
// set.
//
// The values are deliberately LOW starting points. Free tiers meter requests
// per minute/tokens per minute, not per request, and an in-flight burst on one
// key mostly 429s its siblings; a cap of 5–10 only ever skips a key that is
// ALREADY saturated, so being conservative costs at most a burst of parallel
// throughput and never a rejected request. Platforms are only listed when
// their free tier is a real, recurring, per-key allowance — one-off promo
// gateways stay uncapped (a wrong default is worse than none), and per-
// ACCOUNT quota pools (e.g. Gemini-style project quotas) do not stack across
// keys anyway, so a per-key cap there would be the wrong shape.
//
// Every entry is overridable per platform with
// MAX_CONCURRENT_REQUESTS_PER_KEY_<PLATFORM> (env always wins); set the env
// var to a value the operator measured, not what this table says.
export const BUILTIN_KEY_CONCURRENCY: Record<string, number> = {
  // Free tier: ~1,440 req/min shared across all models — bursts beyond a few
  // in-flight on one key 429 each other.
  groq: 5,
  // Free tier: per-model RPM ceiling, small.
  cerebras: 5,
  // Free tier: 10–15 RPM per model family on the free models.
  google: 5,
  // NIM free: 1,000 credits/month — the sustainable rate is very low.
  nvidia: 5,
  // La Plateforme free: 150 RPM account-wide.
  mistral: 5,
  // Free Inference Providers: calls/hour budget across the meta-router.
  huggingface: 5,
  // Aggregator with a per-account fair-use policy — looser than the direct
  // free tiers, still burst-sensitive.
  openrouter: 10,
  // GitHub Models free tier: very conservative request budget.
  github: 2,
  // Free tier: 10K tokens/day — concurrency above 2 would starve it.
  cohere: 2,
};

// Setting key; '1' enables the built-in table. Off by default so existing
// installs keep the exact env-var-only behaviour.
export const BUILTIN_KEY_CONCURRENCY_SETTING = 'routing_builtin_key_concurrency';

// The env var pins the behaviour over the dashboard setting (same pattern as
// the other routing toggles): 1/true/on forces on, 0/false/off forces off.
export function isBuiltinKeyConcurrencyEnabled(): boolean {
  const env = process.env.ROUTER_BUILTIN_KEY_CONCURRENCY;
  if (env !== undefined && env.trim() !== '') {
    const v = env.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'off') return false;
  }
  return getSetting(BUILTIN_KEY_CONCURRENCY_SETTING) === '1';
}

export function setBuiltinKeyConcurrency(enabled: boolean): void {
  if (enabled) {
    setSetting(BUILTIN_KEY_CONCURRENCY_SETTING, '1');
  } else {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(BUILTIN_KEY_CONCURRENCY_SETTING);
  }
}
