import { getDb } from '../db/index.js';
import { recordRequestTelemetry } from '../services/analytics-aggregator.js';
import { getActiveRegistry } from '../services/router-registry.js';
import { settleMonthlyUsage } from '../services/key-budget.js';
import { getClientContext } from './client-context.js';
import { noteRequestRowId, type RequestTrace } from './attempt-trace.js';

// Memory-first zero-DB request logging
export function logRequest(
  platform: string,
  modelId: string,
  keyId: number | null,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null,
  _ttfbMs: number | null = null,
  _requestedModel: string | null = null,
  _servedModel: string | null = null,
  // Which gateway pathway produced the request ('http' for the OpenAI-
  // compatible proxy, /v1/responses, /v1/messages, the Ollama + Gemini wires
  // and fusion's sub-calls; 'mcp' / 'web' for the other surfaces). Persisted
  // on the request row's own `caller` column (#1102) — the fork's port used
  // to fold it into `client_agent`, which belongs to the agent classifier.
  _caller: string | null = null,
) {
  try {
    const isSuccess = status === 'success';
    const isRateLimit = error?.includes('429') || error?.toLowerCase().includes('rate limit');
    const isTimeout = error?.toLowerCase().includes('timeout');

    // Find provider ID from active registry if available
    let providerId: number | null = null;
    const registry = getActiveRegistry();
    if (registry) {
      const p = registry.getProviderByKey(platform.toLowerCase());
      if (p) providerId = p.id;
    }

    // Monthly ledger (#1158): settle successful usage per key as a
    // fire-and-forget so bookkeeping never stalls the response; the
    // reservation already guarded admission, and this closes the loop.
    if (isSuccess && keyId != null) {
      void settleMonthlyUsage(keyId, Math.max(0, inputTokens || 0) + Math.max(0, outputTokens || 0));
    }

    recordRequestTelemetry({
      providerId,
      providerKey: platform,
      modelId,
      success: isSuccess,
      inputTokens: inputTokens || 0,
      outputTokens: outputTokens || 0,
      totalTokens: (inputTokens || 0) + (outputTokens || 0),
      latencyMs: latencyMs || 0,
      isRateLimit: !!isRateLimit,
      isTimeout: !!isTimeout,
    });

    const db = getDb();
    if (typeof db?.query === 'function') {
      const client = getClientContext();
      const qPromise = db.query(
        `INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms, requested_model, served_model, client_agent, caller)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
        [platform, modelId, keyId, status, inputTokens || 0, outputTokens || 0, latencyMs || 0, error || null, _ttfbMs, _requestedModel, _servedModel, client.agent, _caller]
      );
      if (qPromise && typeof qPromise.then === 'function') {
        qPromise.then((res: any) => {
          const insertedId = res?.rows?.[0]?.id;
          if (insertedId != null) noteRequestRowId(insertedId);
        }).catch(() => {});
      }
    }
  } catch (e) {
    // Analytics logging failure must never crash inference
    console.error('[request-log] Error recording telemetry:', e);
  }
}

export function persistRequestAttempts(trace: RequestTrace): void {
  if (trace.records.length === 0 || trace.lastRequestRowId == null) return;
  try {
    const db = getDb();
    if (typeof db?.query === 'function') {
      for (const r of trace.records) {
        db.query(
          `INSERT INTO request_attempts (request_id, ordinal, platform, model_id, key_ordinal, key_label, outcome, start_offset_ms, duration_ms, error_summary)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [trace.lastRequestRowId, r.ordinal, r.platform, r.modelId, r.keyOrdinal, r.keyLabel, r.outcome, r.startOffsetMs, r.durationMs, r.errorSummary]
        ).catch(() => {});
      }
    }
  } catch (e) {
    console.error('Failed to persist request attempts:', e);
  }
}
