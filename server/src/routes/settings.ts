import { Router } from 'express';
import type { Request, Response } from 'express';
import { getUnifiedApiKey, regenerateUnifiedKey, getSetting, setSetting, getDb } from '../db/index.js';
import { applyProxyUrl, applyProxyMode, applyProxyEnabled, applyProxyBypass, applyFetchRelayToken, encodeFetchRelayToken, isProxyActive, getProxyUrl, getProxyMode, getFetchRelayToken, isProxyEnabled, getProxyBypassPlatforms, probeProxyUrl, fetchRelayUrlError, DEFAULT_PROXY_PROBE_TARGET, PROXY_MODES, PROXY_SCHEMES } from '../lib/proxy.js';
import { getProvider } from '../providers/index.js';
import type { Platform } from '@freellmapi/shared/types.js';
import type { ProxyMode } from '@freellmapi/shared/types.js';
import { getSavedFusionConfig, setSavedFusionConfig, savedFusionConfigSchema, getFusionMaxK } from '../services/fusion.js';
import { isUnifyEnabled, setUnifyEnabled, getUnifyOverrides, setUnifyOverrides, unifyOverridesSchema } from '../services/model-groups.js';
import { getClaudeModelMap, setClaudeModelMap } from '../services/anthropic-map.js';
import { getGeminiModelMap, setGeminiModelMap } from '../services/gemini-map.js';
import { getOllamaEmulationMode } from './ollama.js';
import { MIN_CONTEXT_WINDOW_SETTING, MIN_CONTEXT_WINDOW_PRESETS } from '../lib/min-context-window.js';
import { UPDATE_CHECK_SETTING, isAutoUpdateCheckEnabled } from './update.js';
import { listUrlTokens, mintUrlToken, revokeUrlToken } from '../services/url-tokens.js';
import {
  getRequestMaxTokensBudget,
  getMaxConsecutiveUpstreamFails,
  REQUEST_MAX_TOKENS_BUDGET_SETTING,
  MAX_CONSECUTIVE_UPSTREAM_FAILS_SETTING,
} from '../lib/guardrails.js';
import {
  compressionUpdateSchema,
  getCompressionConfig,
  setCompressionConfig,
} from '../services/compression/config.js';
import { getHeadroomThresholds, setHeadroomThresholds, getTaskWeightShare, setTaskWeightShare, getMinReliabilityFloor, setMinReliabilityFloor, isProviderMomentAttributionEnabled, setProviderMomentAttribution } from '../services/router.js';
import { MCP_ENABLED_SETTING, isMcpServerEnabled } from './mcp.js';
import { z } from 'zod';
import { getAppVersion } from '../lib/app-version.js';
import {
  UNIFIED_MAX_TOKENS_SETTING,
  UNIFIED_MAX_TOKENS_AUTO,
  unifiedMaxTokensCap,
} from '../lib/sampling-params.js';

export const settingsRouter = Router();

// Which RELEASE this install is, for the dashboard's version row (#703).
// Deliberately NOT /api/version: the Ollama emulation already owns that path
// and answers it for real Ollama clients, so mounting here would have shadowed
// it. `null` means the version could not be established honestly, and the
// dashboard then shows nothing rather than a number that isn't the release.
settingsRouter.get('/version', (_req: Request, res: Response) => {
  res.json({ version: getAppVersion() });
});

// Opt-in for the dashboard's automatic release reminder (#782). Off unless the
// operator turns it on: a self-hosted install must not contact GitHub on page
// load on behalf of someone who never asked it to. The manual checker in
// Settings is a separate surface and is unaffected by this flag.
const updateCheckSchema = z.object({ enabled: z.boolean() }).strict();

settingsRouter.get('/update-check', async (_req: Request, res: Response) => {
  res.json({ enabled: await isAutoUpdateCheckEnabled() });
});

settingsRouter.put('/update-check', async (req: Request, res: Response) => {
  const parsed = updateCheckSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid update check setting: ${parsed.error.errors.map(error => error.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }
  await setSetting(UPDATE_CHECK_SETTING, parsed.data.enabled ? '1' : '0');
  res.json({ enabled: await isAutoUpdateCheckEnabled() });
});

settingsRouter.get('/compression', async (_req: Request, res: Response) => {
  res.json(await getCompressionConfig());
});

settingsRouter.put('/compression', async (req: Request, res: Response) => {
  const parsed = compressionUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    res.status(400).json({
      error: { message: `Invalid compression settings: ${detail}`, type: 'invalid_request_error' },
    });
    return;
  }
  res.json(await setCompressionConfig(parsed.data));
});

// Get the model-unification setting: the global toggle (default ON) plus any
// merge/split overrides. Governs the dashboard grouping, /v1/models grouping,
// and cross-provider pin failover.
settingsRouter.get('/unify', async (_req: Request, res: Response) => {
  res.json({ enabled: isUnifyEnabled(), overrides: await getUnifyOverrides() });
});

const unifyPutSchema = z.object({
  enabled: z.boolean().optional(),
  overrides: unifyOverridesSchema.optional(),
});

// Update the unify toggle and/or overrides. Partial: send just `enabled` to
// flip the switch, or `overrides` to adjust grouping, or both.
settingsRouter.put('/unify', async (req: Request, res: Response) => {
  const parsed = unifyPutSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors.map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ');
    res.status(400).json({ error: { message: `Invalid unify settings: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  if (parsed.data.enabled !== undefined) await setUnifyEnabled(parsed.data.enabled);
  if (parsed.data.overrides) await setUnifyOverrides(parsed.data.overrides);
  res.json({ enabled: isUnifyEnabled(), overrides: await getUnifyOverrides() });
});

// Get the saved fusion default config (panel mode, models, judge, k, strategy).
settingsRouter.get('/fusion', async (_req: Request, res: Response) => {
  res.json({ config: await getSavedFusionConfig(), maxK: await getFusionMaxK() });
});

// Save the fusion default config. A request's inline `fusion` field still
// overrides this per call (see services/fusion.ts resolveEffectiveConfig).
settingsRouter.put('/fusion', async (req: Request, res: Response) => {
  const parsed = savedFusionConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors.map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ');
    res.status(400).json({ error: { message: `Invalid fusion config: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  const saved = await setSavedFusionConfig(parsed.data);
  res.json({ config: saved, maxK: await getFusionMaxK() });
});

// ── MCP server lifecycle (#925, MVP-1) ──────────────────────────────────────
// Config surface for the /mcp introspection server. The Keys page renders this
// as a switch under Agent compatibility; the stored default is seeded once by
// migration so upgrades keep serving the clients they already had.

settingsRouter.get('/enable-mcp', async (_req: Request, res: Response) => {
  res.json({ enabled: await isMcpServerEnabled() });
});

const enableMcpSchema = z.object({ enabled: z.boolean() });

settingsRouter.put('/enable-mcp', async (req: Request, res: Response) => {
  const parsed = enableMcpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid MCP setting: enabled must be a boolean.', type: 'invalid_request_error' } });
    return;
  }
  await setSetting(MCP_ENABLED_SETTING, parsed.data.enabled ? '1' : '0');
  res.json({ enabled: parsed.data.enabled });
});

// Get the Claude Code model map (opus/sonnet/haiku/default → 'auto' | model_id).
// Drives how the Anthropic /v1/messages route resolves Claude Code's built-in
// model names against the free pool.
settingsRouter.get('/anthropic-map', async (_req: Request, res: Response) => {
  res.json({ map: await getClaudeModelMap() });
});

// Update the Claude Code model map. Partial: send just the families you want to
// change; each value is 'auto', a catalog model_id, or a tier selector
// (`tier:pro` | `tier:mid` | `tier:normal`) that routes over the whole
// capability tier instead of one model.
settingsRouter.put('/anthropic-map', async (req: Request, res: Response) => {
  try {
    res.json({ map: await setClaudeModelMap(req.body) });
  } catch (err: any) {
    const detail = err?.errors
      ? err.errors.map((e: any) => (e.path?.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ')
      : (err?.message ?? 'invalid');
    res.status(400).json({ error: { message: `Invalid anthropic model map: ${detail}`, type: 'invalid_request_error' } });
  }
});

settingsRouter.get('/gemini-map', async (_req: Request, res: Response) => {
  res.json({ map: await getGeminiModelMap() });
});

settingsRouter.put('/gemini-map', async (req: Request, res: Response) => {
  try {
    res.json({ map: await setGeminiModelMap(req.body) });
  } catch (err: any) {
    const detail = err?.errors
      ? err.errors.map((e: any) => (e.path?.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ')
      : (err?.message ?? 'invalid');
    res.status(400).json({ error: { message: `Invalid Gemini model map: ${detail}`, type: 'invalid_request_error' } });
  }
});

const compatibilitySchema = z.object({
  ollamaEmulation: z.enum(['off', 'open-loopback', 'key-required']).optional(),
  exposeClaudeDiscoveryAliases: z.boolean().optional(),
}).strict();

settingsRouter.get('/agent-compatibility', async (_req: Request, res: Response) => {
  res.json({
    ollamaEmulation: await getOllamaEmulationMode(),
    exposeClaudeDiscoveryAliases: await getSetting('expose_cc_discovery_aliases') === '1',
  });
});

settingsRouter.put('/agent-compatibility', async (req: Request, res: Response) => {
  const parsed = compatibilitySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid agent compatibility settings: ${parsed.error.errors.map(error => error.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }
  if (parsed.data.ollamaEmulation) await setSetting('ollama_emulation', parsed.data.ollamaEmulation);
  if (parsed.data.exposeClaudeDiscoveryAliases !== undefined) {
    await setSetting('expose_cc_discovery_aliases', parsed.data.exposeClaudeDiscoveryAliases ? '1' : '0');
  }
  res.json({
    ollamaEmulation: await getOllamaEmulationMode(),
    exposeClaudeDiscoveryAliases: await getSetting('expose_cc_discovery_aliases') === '1',
  });
});

settingsRouter.get('/url-tokens', async (_req: Request, res: Response) => {
  res.json({ tokens: await listUrlTokens() });
});

settingsRouter.post('/url-tokens', async (req: Request, res: Response) => {
  const parsed = z.object({ label: z.string().max(120).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid URL token label', type: 'invalid_request_error' } });
    return;
  }
  res.status(201).json(await mintUrlToken(parsed.data.label ?? ''));
});

settingsRouter.delete('/url-tokens/:id', async (req: Request, res: Response) => {
  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid URL token id', type: 'invalid_request_error' } });
    return;
  }
  if (!await revokeUrlToken(id)) {
    res.status(404).json({ error: { message: 'Active URL token not found', type: 'not_found_error' } });
    return;
  }
  res.status(204).end();
});

// The unified output-token cap as the dashboard sees it. `mode` is exactly
// what PUT accepts back — 'off', 'auto', or the integer itself, never a
// stringified number — so a read/modify/write round trip can't 400 on its own
// output. A stored value that unifiedMaxTokensCap() doesn't understand is
// reported as 'off', which is how it actually behaves (effectiveCap null).
async function outputLimitState(): Promise<{ mode: 'off' | 'auto' | number; effectiveCap: number | null; autoValue: number }> {
  const raw = (await getSetting(UNIFIED_MAX_TOKENS_SETTING) ?? '').trim().toLowerCase();
  const effectiveCap = await unifiedMaxTokensCap();
  const mode = raw === 'auto' ? 'auto' as const : (effectiveCap ?? 'off' as const);
  return { mode, effectiveCap, autoValue: UNIFIED_MAX_TOKENS_AUTO };
}

// Get the unified output-token cap ('off' = disabled, 'auto' = 32768, or an
// explicit integer). See lib/sampling-params.ts unifiedMaxTokensCap().
settingsRouter.get('/output-limit', async (_req: Request, res: Response) => {
  res.json(await outputLimitState());
});

const outputLimitPutSchema = z.object({
  mode: z.union([
    z.literal('off'),
    z.literal('auto'),
    z.number().int().min(1),
  ]),
});

// Update the unified output-token cap. 'off' restores pass-through behaviour;
// 'auto' clamps every request's max_tokens to UNIFIED_MAX_TOKENS_AUTO; an
// integer clamps to that value. Takes effect on the next request.
settingsRouter.put('/output-limit', async (req: Request, res: Response) => {
  const parsed = outputLimitPutSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    res.status(400).json({ error: { message: `Invalid output limit: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  await setSetting(UNIFIED_MAX_TOKENS_SETTING, String(parsed.data.mode));
  res.json(await outputLimitState());
});

// Get the min-context-window pool floor ('off' = disabled, or a preset key
// like '128k'). See lib/min-context-window.ts minContextWindowFloor().
settingsRouter.get('/min-context-window', async (_req: Request, res: Response) => {
  let value = 'off';
  try {
    value = await getSetting(MIN_CONTEXT_WINDOW_SETTING) || 'off';
  } catch {
    // DB not ready — report the disabled default rather than failing.
  }
  res.json({ value, presets: MIN_CONTEXT_WINDOW_PRESETS });
});

const minContextWindowPutSchema = z.object({
  value: z.union([
    z.literal('off'),
    z.string().regex(/^(32k|128k|512k|1m)$/i),
  ]),
});

// Update the min-context-window pool floor. Upward-compatible by construction:
// '128k' keeps every model at or above 128k (including 512k and 1M). Takes
// effect on the next routed request — no restart.
settingsRouter.put('/min-context-window', async (req: Request, res: Response) => {
  const parsed = minContextWindowPutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: "Invalid min context window: value must be 'off', '32k', '128k', '512k', or '1m'", type: 'invalid_request_error' } });
    return;
  }
  await setSetting(MIN_CONTEXT_WINDOW_SETTING, parsed.data.value.toLowerCase());
  res.json({ value: parsed.data.value.toLowerCase(), presets: MIN_CONTEXT_WINDOW_PRESETS });
});

// Get the request guardrails (per-request token budget + failover circuit
// breaker). Both default to 0 = disabled; see lib/guardrails.ts.
settingsRouter.get('/guardrails', async (_req: Request, res: Response) => {
  res.json({
    requestMaxTokensBudget: await getRequestMaxTokensBudget(),
    maxConsecutiveUpstreamFails: await getMaxConsecutiveUpstreamFails(),
  });
});

const guardrailsPutSchema = z.object({
  requestMaxTokensBudget: z.number().int().min(0).optional(),
  maxConsecutiveUpstreamFails: z.number().int().min(0).optional(),
});

// Get the headroom guardrail thresholds (#899): the remaining-budget fraction
// at which proactive demotion begins and the score floor at 0 remaining. Both
// are decimals (0.2 = 20%). null = the scoring.ts default is in effect.
settingsRouter.get('/headroom', async (_req: Request, res: Response) => {
  const { rampStart, floor } = await getHeadroomThresholds();
  res.json({ rampStart: rampStart ?? null, floor: floor ?? null });
});

const headroomPutSchema = z.object({
  rampStart: z.number().min(0).max(1).nullable().optional(),
  floor: z.number().min(0).max(1).nullable().optional(),
});

// Update the headroom guardrail thresholds. null clears a threshold back to the
// scoring.ts default. Takes effect on the next request — no restart needed.
settingsRouter.put('/headroom', async (req: Request, res: Response) => {
  const parsed = headroomPutSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    res.status(400).json({ error: { message: `Invalid headroom thresholds: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  try {
    await setHeadroomThresholds(parsed.data.rampStart, parsed.data.floor);
    const { rampStart, floor } = await getHeadroomThresholds();
    res.json({ rampStart: rampStart ?? null, floor: floor ?? null });
  } catch (err: any) {
    res.status(400).json({ error: { message: `Invalid headroom thresholds: ${err.message}`, type: 'invalid_request_error' } });
  }
});

// Task-type weight share (#1127 follow-up): the fraction of one bandit axis
// moved onto the other when a request declares/derives a task type (code →
// intelligence; chat → speed). 0 = bias disabled. null = scoring.ts default.
settingsRouter.get('/task-weight-share', async (_req: Request, res: Response) => {
  res.json({ share: await getTaskWeightShare() });
});

const taskWeightSharePutSchema = z.object({
  share: z.number().min(0).max(1).nullable().optional(),
});

// Update the task-type weight share. null clears back to the default. Takes
// effect on the next request — no restart needed.
settingsRouter.put('/task-weight-share', async (req: Request, res: Response) => {
  const parsed = taskWeightSharePutSchema.safeParse(req.body);
  if (!parsed.success || parsed.data.share === undefined) {
    res.status(400).json({ error: { message: 'Invalid task-weight-share: send {"share": 0..1 | null}', type: 'invalid_request_error' } });
    return;
  }
  try {
    await setTaskWeightShare(parsed.data.share);
    res.json({ share: await getTaskWeightShare() });
  } catch (err: any) {
    res.status(400).json({ error: { message: `Invalid task-weight-share: ${err.message}`, type: 'invalid_request_error' } });
  }
});

// Minimum reliability floor (#filter): drop models whose observed success rate
// falls below this decimal (0.8 = 80%) from routing. Under-observed models stay
// in the exploration pool, and the floor never empties the whole chain. null =
// disabled (the default for existing installs).
settingsRouter.get('/min-reliability-floor', async (_req: Request, res: Response) => {
  res.json({ floor: await getMinReliabilityFloor() ?? null });
});

const minReliabilityFloorPutSchema = z.object({
  floor: z.number().min(0).max(1).nullable().optional(),
});

// Update the minimum reliability floor. null clears back to disabled. Takes
// effect on the next request — no restart needed.
settingsRouter.put('/min-reliability-floor', async (req: Request, res: Response) => {
  const parsed = minReliabilityFloorPutSchema.safeParse(req.body);
  if (!parsed.success || parsed.data.floor === undefined) {
    res.status(400).json({ error: { message: 'Invalid min-reliability-floor: send {"floor": 0..1 | null}', type: 'invalid_request_error' } });
    return;
  }
  try {
    await setMinReliabilityFloor(parsed.data.floor);
    res.json({ floor: await getMinReliabilityFloor() ?? null });
  } catch (err: any) {
    res.status(400).json({ error: { message: `Invalid min-reliability-floor: ${err.message}`, type: 'invalid_request_error' } });
  }
});

// Provider-moment failure attribution (opt-in, #1347): tag 429 / 5xx /
// timeout / transport failures as the provider's bad minute so they steer the
// key without counting against the model's reliability. Off by default; the
// ROUTER_PROVIDER_MOMENT_ATTRIBUTION env var pins the behaviour when set.
settingsRouter.get('/provider-moment-attribution', async (_req: Request, res: Response) => {
  res.json({ enabled: await isProviderMomentAttributionEnabled() });
});

const providerMomentAttributionPutSchema = z.object({
  enabled: z.boolean(),
});

// Update the failure-attribution toggle. Takes effect immediately — the
// setter force-refreshes the stats cache that bakes the filter in.
settingsRouter.put('/provider-moment-attribution', async (req: Request, res: Response) => {
  const parsed = providerMomentAttributionPutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid provider-moment-attribution: send {"enabled": true|false}', type: 'invalid_request_error' } });
    return;
  }
  await setProviderMomentAttribution(parsed.data.enabled);
  res.json({ enabled: await isProviderMomentAttributionEnabled() });
});

// Update the guardrails. Partial: send just the knob you want to change.
// Takes effect on the next request — no restart needed. 0 disables a knob.
settingsRouter.put('/guardrails', async (req: Request, res: Response) => {
  const parsed = guardrailsPutSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors.map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ');
    res.status(400).json({ error: { message: `Invalid guardrail settings: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  if (parsed.data.requestMaxTokensBudget !== undefined) {
    await setSetting(REQUEST_MAX_TOKENS_BUDGET_SETTING, String(parsed.data.requestMaxTokensBudget));
  }
  if (parsed.data.maxConsecutiveUpstreamFails !== undefined) {
    await setSetting(MAX_CONSECUTIVE_UPSTREAM_FAILS_SETTING, String(parsed.data.maxConsecutiveUpstreamFails));
  }
  res.json({
    requestMaxTokensBudget: await getRequestMaxTokensBudget(),
    maxConsecutiveUpstreamFails: await getMaxConsecutiveUpstreamFails(),
  });
});

// Get the unified API key
settingsRouter.get('/api-key', async (_req: Request, res: Response) => {
  res.json({ apiKey: await getUnifiedApiKey() });
});

// Regenerate the unified API key
settingsRouter.post('/api-key/regenerate', async (_req: Request, res: Response) => {
  const newKey = await regenerateUnifiedKey();
  res.json({ apiKey: newKey });
});

// Get the proxy settings
settingsRouter.get('/proxy', (_req: Request, res: Response) => {
  res.json({
    proxyUrl: getProxyUrl(),
    proxyMode: getProxyMode(),
    fetchRelayTokenConfigured: Boolean(getFetchRelayToken()),
    enabled: isProxyEnabled(),
    bypassPlatforms: getProxyBypassPlatforms(),
    active: isProxyActive(),
  });
});

// A forward proxy only tunnels the TLS session, so plain http to the proxy is
// fine. A relay is the opposite: the provider API key and the relay token ride
// inside the request it forwards, in the clear, so the hop to the relay has to
// be https unless the relay is on this machine. fetchRelayUrlError owns that
// rule and the boot-time env guard applies the same one.
function proxyUrlError(proxyUrl: string, proxyMode: ProxyMode): string | undefined {
  if (!proxyUrl) return undefined;
  if (proxyMode === 'fetch-relay') return fetchRelayUrlError(proxyUrl);
  try {
    const protocol = new URL(proxyUrl).protocol;
    if (!PROXY_SCHEMES.includes(protocol)) {
      return 'Proxy URL must use http, https, socks5, socks5h, socks4, or socks4a scheme';
    }
  } catch {
    return 'Invalid proxy URL — must be a valid URL like socks5://host:port';
  }
  return undefined;
}

// Set the proxy settings. Accepts partial updates.
settingsRouter.put('/proxy', async (req: Request, res: Response) => {
  const { proxyUrl, proxyMode, fetchRelayToken, enabled, bypassPlatforms } = req.body as {
    proxyUrl?: string;
    proxyMode?: ProxyMode;
    fetchRelayToken?: string;
    enabled?: boolean;
    bypassPlatforms?: string[];
  };

  if (proxyMode !== undefined && !PROXY_MODES.includes(proxyMode)) {
    res.status(400).json({
      error: { message: 'Proxy mode must be forward or fetch-relay', type: 'invalid_request_error' },
    });
    return;
  }

  // Only validate the URL when this request actually decides it. A body that
  // touches neither proxyUrl nor proxyMode — the enabled switch, the
  // per-platform bypass list — must not 400 on an ambient ALL_PROXY value the
  // dashboard never set and cannot fix (getProxyUrl may return exactly that).
  if (typeof proxyUrl === 'string' || proxyMode !== undefined) {
    const nextMode = proxyMode ?? getProxyMode();
    const nextUrl = typeof proxyUrl === 'string' ? proxyUrl.trim() : getProxyUrl();
    const urlError = proxyUrlError(nextUrl, nextMode);
    if (urlError) {
      res.status(400).json({ error: { message: urlError, type: 'invalid_request_error' } });
      return;
    }
  }

  // --- proxyUrl ---
  if (typeof proxyUrl === 'string') {
    const trimmed = proxyUrl.trim();
    await setSetting('proxy_url', trimmed);
    applyProxyUrl(trimmed);
  }

  // --- proxyMode ---
  if (proxyMode !== undefined) {
    await setSetting('proxy_mode', proxyMode);
    applyProxyMode(proxyMode);
  }

  // --- fetchRelayToken ---
  // Never return this value from the API. Undefined retains the saved token;
  // an explicit empty string clears it.
  if (typeof fetchRelayToken === 'string') {
    const trimmed = fetchRelayToken.trim();
    await setSetting('fetch_relay_token', encodeFetchRelayToken(trimmed));
    applyFetchRelayToken(trimmed);
  }

  // --- enabled ---
  if (typeof enabled === 'boolean') {
    await setSetting('proxy_enabled', enabled ? '1' : '0');
    applyProxyEnabled(enabled);
  }

  // --- bypassPlatforms ---
  if (Array.isArray(bypassPlatforms)) {
    const csv = bypassPlatforms.map(s => s.trim()).filter(Boolean).join(',');
    await setSetting('proxy_bypass', csv);
    applyProxyBypass(csv);
  }

  res.json({
    proxyUrl: getProxyUrl(),
    proxyMode: getProxyMode(),
    fetchRelayTokenConfigured: Boolean(getFetchRelayToken()),
    enabled: isProxyEnabled(),
    bypassPlatforms: getProxyBypassPlatforms(),
    active: isProxyActive(),
  });
});

// Test proxy connectivity WITHOUT saving (#863). The dashboard's "Test" button
// sends the DRAFT value; an empty body falls back to the saved proxy URL. The
// probe never persists anything — it only builds a throwaway dispatcher and
// measures a round trip through the (draft or saved) proxy.
/**
 * What the proxy probe should call.
 *
 * The question the Test button answers is "can outbound traffic from THIS
 * install reach the upstreams it routes to", so the target is the /models
 * endpoint of a provider the operator actually holds an enabled key for —
 * preferring one that is not bypassing the proxy, since a bypassed platform
 * would not exercise the proxy at all. PROXY_TEST_URL overrides everything for
 * air-gapped or mirror-only deployments. With no keys at all there is no
 * upstream to name, and only then does the neutral fallback apply.
 */
async function proxyProbeTarget(): Promise<string> {
  const override = (process.env.PROXY_TEST_URL ?? '').trim();
  if (override) return override;

  let platforms: { platform: string }[] = [];
  try {
    platforms = await getDb().all(`SELECT DISTINCT platform FROM api_keys WHERE enabled = 1 ORDER BY platform`) as { platform: string }[];
  } catch {
    return DEFAULT_PROXY_PROBE_TARGET;
  }

  const bypassed = new Set(getProxyBypassPlatforms());
  const candidates = [
    ...platforms.filter(row => !bypassed.has(row.platform)),
    ...platforms.filter(row => bypassed.has(row.platform)),
  ];
  for (const row of candidates) {
    // 'custom' has no single registered base URL, and a provider may expose no
    // OpenAI-style catalog route at all; skip rather than invent one.
    if (row.platform === 'custom') continue;
    const url = (getProvider(row.platform as Platform) as { modelsUrl?: string } | undefined)?.modelsUrl;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
  }
  return DEFAULT_PROXY_PROBE_TARGET;
}

settingsRouter.post('/proxy/test', async (req: Request, res: Response) => {
  const { proxyUrl, proxyMode, fetchRelayToken } = (req.body ?? {}) as {
    proxyUrl?: string;
    proxyMode?: ProxyMode;
    fetchRelayToken?: string;
  };
  if (proxyMode !== undefined && !PROXY_MODES.includes(proxyMode)) {
    res.status(400).json({ error: { message: 'Proxy mode must be forward or fetch-relay', type: 'invalid_request_error' } });
    return;
  }
  const mode = proxyMode ?? getProxyMode();
  const url = (proxyUrl ?? '').trim() || getProxyUrl();
  const urlError = proxyUrlError(url, mode);
  if (urlError) {
    res.status(400).json({ error: { message: urlError, type: 'invalid_request_error' } });
    return;
  }
  const result = await probeProxyUrl(proxyUrl, {
    targetUrl: await proxyProbeTarget(),
    mode,
    relayToken: typeof fetchRelayToken === 'string' && fetchRelayToken.trim()
      ? fetchRelayToken.trim()
      : getFetchRelayToken(),
  });
  res.json(result);
});
