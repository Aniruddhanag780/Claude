import { Router } from 'express';
import type { Request, Response } from 'express';
import { getActiveRegistry } from '../services/router-registry.js';
import { getPostgresPool } from '../db/postgres.js';
import { getDb } from '../db/index.js';
import { hasProvider, resolveProvider } from '../providers/index.js';
import { checkKeyHealth, checkAllKeys, pollKeyQuota, supportsQuotaPolling } from '../services/health.js';
import { getQuotaStateForKeys } from '../services/provider-quota.js';
import type { Platform } from '@freellmapi/shared/types.js';

export const healthRouter = Router();

// GET /api/health - System and provider health status
healthRouter.get('/', (_req: Request, res: Response) => {
  try {
    const registry = getActiveRegistry();
    const providers = registry.getAllProviders();
    const credentials = registry.getAllCredentials();
    const now = Date.now();

    const providerHealthList = providers.map(p => {
      const creds = registry.getCredentialsForProvider(p.id);
      const totalKeys = creds.length;
      const enabledKeys = creds.filter(c => c.enabled).length;
      const healthyKeys = creds.filter(c => c.enabled && c.runtime.cooldownUntil <= now).length;
      const rateLimitedKeys = creds.filter(c => c.enabled && c.runtime.cooldownUntil > now).length;
      const invalidKeys = creds.filter(c => !c.enabled).length;

      let status = 'unknown';
      if (!p.enabled || enabledKeys === 0) {
        status = 'disabled';
      } else if (healthyKeys > 0) {
        status = 'healthy';
      } else if (rateLimitedKeys > 0) {
        status = 'cooldown';
      } else {
        status = 'degraded';
      }

      return {
        platform: p.key,
        displayName: p.displayName,
        hasProvider: hasProvider(p.key as Platform),
        status,
        totalKeys,
        enabledKeys,
        healthyKeys,
        rateLimitedKeys,
        invalidKeys,
        errorKeys: 0,
        unknownKeys: 0,
      };
    });

    const keyHealthList = credentials.map(c => {
      const isCooldown = c.runtime.cooldownUntil > now;
      let status = 'healthy';
      if (!c.enabled) {
        status = 'invalid';
      } else if (isCooldown) {
        status = 'rate_limited';
      } else if (c.runtime.circuitState === 'DEGRADED') {
        status = 'degraded';
      }

      return {
        id: c.id,
        platform: c.providerKey,
        label: c.name,
        status,
        enabled: c.enabled,
        activeRequests: c.runtime.activeRequests,
        ewmaLatencyMs: c.runtime.ewmaLatencyMs,
        cooldownRemainingMs: Math.max(0, c.runtime.cooldownUntil - now),
        lastUsedAt: c.runtime.lastUsedAt ? new Date(c.runtime.lastUsedAt).toISOString() : null,
        lastFailedAt: c.runtime.lastFailedAt ? new Date(c.runtime.lastFailedAt).toISOString() : null,
        lastCheckedAt: c.runtime.lastUsedAt ? new Date(c.runtime.lastUsedAt).toISOString() : null,
        lastHealthError: c.runtime.lastHealthError,
      };
    });

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      platforms: providerHealthList,
      keys: keyHealthList,
    });
  } catch (err: any) {
    console.error('[health] Error getting health status:', err);
    res.status(500).json({ error: 'Failed to get health status' });
  }
});

// POST /api/health/check-all — run a full health pass across every enabled key.
healthRouter.post('/check-all', async (_req: Request, res: Response) => {
  try {
    const result = await checkAllKeys({ force: true });
    await (await import('../services/router-registry.js')).reloadRoutingRegistry();
    res.json({ ok: true, checked: result.checkedKeyIds.length, skipped: result.skippedKeyIds.length });
  } catch (err: any) {
    console.error('[health] Error running full health check:', err);
    res.status(500).json({ error: 'Failed to run health check' });
  }
});

// POST /api/health/check/:id — health-check a single credential.
healthRouter.post('/check/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid key ID' });
      return;
    }
    const status = await checkKeyHealth(id);
    await refreshRuntimeHealth(id);
    res.json({ ok: true, id, status });
  } catch (err: any) {
    console.error('[health] Error checking key:', err);
    res.status(500).json({ error: 'Failed to check key' });
  }
});

// After a health check updates the DB, mirror the fresh error / timestamps into
// the in-memory registry runtime so /api/health returns them immediately
// instead of waiting for the next registry reload.
async function refreshRuntimeHealth(id: number): Promise<void> {
  const registry = getActiveRegistry();
  const record = registry.getCredentialById(id);
  if (!record) return;
  const pool = getPostgresPool();
  const res = await pool.query(
    `SELECT last_health_error, last_checked_at FROM credentials WHERE id = $1`,
    [id]
  );
  const row = res.rows[0];
  if (!row) return;
  record.runtime.lastHealthError = row.last_health_error || null;
  if (row.last_checked_at) {
    record.runtime.lastUsedAt = new Date(row.last_checked_at).getTime();
  }
}

// Poll one key's provider-reported balance now (#1403). The health pass only
// piggybacks the quota probe at most once per 15 minutes; this is the manual
// override — an operator adding a key wants the balance immediately instead
// of waiting for the next healthy pass after the throttle. Returns what the
// probe recorded (or the fresh state when the provider reported nothing, so
// the caller can tell "no quota endpoint / probe failed" from "fresh number").
healthRouter.post('/quota/:keyId', async (req: Request, res: Response) => {
  const keyId = parseInt(req.params.keyId as string, 10);
  if (isNaN(keyId)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }
  const pool = getPostgresPool();
  const pgRes = await pool.query(
    `SELECT c.id, p.provider_key AS platform, p.base_url,
            c.credential_name, c.encrypted_value, c.iv, c.auth_tag,
            c.enabled, c.last_health_error, c.model_scope
     FROM credentials c
     JOIN providers p ON p.id = c.provider_id
     WHERE c.id = $1`,
    [keyId],
  );
  let row = pgRes.rows[0];
  if (!row) {
    const db = getDb();
    row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as any;
  }
  if (!row) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }
  const provider = resolveProvider(row.platform as Platform, row.base_url);
  if (!provider || !supportsQuotaPolling(provider)) {
    res.status(400).json({ error: { message: `${row.platform} has no provider-reported quota endpoint` } });
    return;
  }
  // pollKeyQuota is failure-silent by design; its boolean tells us whether a
  // quota_api row was written, and the state query returns the fresh reading.
  const recorded = await pollKeyQuota(keyId, row, provider);
  const state = getQuotaStateForKeys().filter(
    q => q.keyId === keyId && q.source === 'quota_api',
  );
  res.json({ keyId, recorded, quotaStates: state });
});
