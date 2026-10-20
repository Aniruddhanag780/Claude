import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getPostgresPool } from '../db/postgres.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { reloadRoutingRegistry } from '../services/router-registry.js';
import { getProvider, hasProvider, getAllProviders } from '../providers/index.js';
import { getDb } from '../db/index.js';
import { isSearchPlatform } from '../lib/search-platforms.js';
import type { Platform, KeyStatus } from '@freellmapi/shared/types.js';
import { normalizeBaseUrl } from '../lib/endpoint-scope.js';
import {
  customEndpointKeyIds,
  resolveCustomEndpointKey,
  endpointHasCredential,
  setCustomEndpointGroup,
  normalizeGroupLabel,
} from '../services/custom-endpoint.js';
import { registerCustomModels } from '../services/custom-model-register.js';
import { registerCustomMediaModel } from '../services/custom-media-register.js';
import { probeEmbeddingDimensions, registerCustomEmbeddingModel } from '../services/embeddings.js';
import { clearCooldownsForKey } from '../services/ratelimit.js';
import {
  discoverEndpointModels,
  probeEndpointModel,
  classifyModelId,
  ModelDiscoveryError,
} from '../services/model-discovery.js';
import { assessProviderUrl } from '../lib/url-guard.js';

export const keysRouter = Router();

const addKeySchema = z.object({
  platform: z.string().min(1),
  key: z.string().optional(),
  label: z.string().optional(),
  baseUrl: z.string().url().optional().nullable(),
  modelScope: z.array(z.string()).optional().nullable(),
  groupLabel: z.string().trim().max(80).optional().nullable(),
});

const updateKeySchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().optional(),
  modelScope: z.array(z.string()).optional().nullable(),
  groupLabel: z.string().trim().max(80).optional().nullable(),
  key: z.string().trim().min(1).optional(),
});

const rotateKeySchema = z.object({
  key: z.string().min(1),
});

// GET /api/keys/providers - Platform summary & checklist
keysRouter.get('/providers', async (_req: Request, res: Response) => {
  try {
    const pool = getPostgresPool();
    let countRows: Array<{ platform: string; total_keys: number; enabled_keys: number }> = [];

    if (pool && !('isMock' in pool && (pool as any).isMock?.())) {
      const resQuery = await pool.query(`
        SELECT p.provider_key as platform,
               COUNT(c.id) as total_keys,
               COUNT(CASE WHEN c.enabled = true THEN 1 END) as enabled_keys
        FROM providers p
        LEFT JOIN credentials c ON c.provider_id = p.id
        GROUP BY p.provider_key
      `);
      countRows = resQuery.rows.map(r => ({
        platform: r.platform,
        total_keys: Number(r.total_keys || 0),
        enabled_keys: Number(r.enabled_keys || 0),
      }));
    } else {
      const db = getDb();
      countRows = (db.prepare(`
        SELECT
          platform,
          COUNT(*) AS total_keys,
          SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled_keys
        FROM api_keys
        GROUP BY platform
      `).all() as Array<{ platform: string; total_keys: number; enabled_keys: number }> | undefined) ?? [];
    }

    const countsByPlatform = new Map(countRows.map(r => [r.platform, r]));

    const providers = getAllProviders()
      .filter(p => p.platform !== 'custom')
      .map(p => {
        const counts = countsByPlatform.get(p.platform);
        const keyCount = counts?.total_keys ?? 0;
        return {
          platform: p.platform,
          name: p.name,
          // 'search' keys serve /v1/search and the agents' web_search tools,
          // never chat (#1174); the dashboard groups them separately.
          kind: isSearchPlatform(p.platform) ? 'search' as const : 'chat' as const,
          keyless: p.keyless,
          configured: keyCount > 0,
          keyCount,
          enabledKeyCount: counts?.enabled_keys ?? 0,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const configured = providers.filter(p => p.configured).length;
    res.json({
      providers,
      summary: {
        total: providers.length,
        configured,
        unconfigured: providers.length - configured,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Failed to list providers' });
  }
});

// 1. GET /api/keys - List all keys with masked values
keysRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const pool = getPostgresPool();
    const queryRes = await pool.query(`
      SELECT
        c.id,
        c.provider_id,
        p.provider_key as platform,
        p.display_name as provider_name,
        p.base_url,
        c.credential_name as label,
        c.credential_type,
        c.enabled,
        c.cooldown_until,
        c.success_count,
        c.failure_count,
        c.last_used_at,
        c.last_failed_at,
        c.last_health_error,
        c.model_scope,
        c.group_label,
        c.encrypted_value,
        c.iv,
        c.auth_tag,
        c.created_at
      FROM credentials c
      JOIN providers p ON p.id = c.provider_id
      ORDER BY p.priority DESC, c.priority DESC, c.id ASC
    `);

    const now = Date.now();
    const keys = queryRes.rows.map((row: any) => {
      let decrypted = '';
      try {
        decrypted = decrypt(row.encrypted_value, row.iv, row.auth_tag);
      } catch {
        decrypted = '****';
      }

      const isCooldown = row.cooldown_until && new Date(row.cooldown_until).getTime() > now;
      let status: KeyStatus = 'healthy';
      if (!row.enabled) {
        status = 'invalid';
      } else if (isCooldown) {
        status = 'rate_limited';
      }

      return {
        id: row.id,
        platform: row.platform,
        providerName: row.provider_name,
        label: row.label || '',
        groupLabel: row.group_label || null,
        maskedKey: maskKey(decrypted),
        baseUrl: row.base_url || null,
        status,
        enabled: row.enabled,
        keyless: row.credential_type === 'keyless',
        exportable: true,
        createdAt: new Date(row.created_at).toISOString(),
        lastCheckedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
        lastHealthError: row.last_health_error || null,
        modelScope: row.model_scope || null,
      };
    });

    // The dashboard's ['keys'] queries expect a bare array (see
    // provider-list, export-keys-dialog, add-key-form, getting-started);
    // returning an object here crashes them with "filter is not a function".
    res.json(keys);
  } catch (err: any) {
    console.error('[keys] Error fetching keys:', err);
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

// 2. POST /api/keys - Add a new credential
keysRouter.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = addKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid key payload: ' + parsed.error.message });
      return;
    }

    const { platform, key = '', label = '', baseUrl = null, modelScope = null, groupLabel = null } = parsed.data;
    const pool = getPostgresPool();

    // 1. Find or create provider
    let providerId: number;
    const pRes = await pool.query('SELECT id, base_url FROM providers WHERE provider_key = $1', [platform]);
    if (pRes.rows.length > 0) {
      providerId = pRes.rows[0].id;
      if (baseUrl && baseUrl !== pRes.rows[0].base_url) {
        await pool.query('UPDATE providers SET base_url = $1, updated_at = NOW() WHERE id = $2', [baseUrl, providerId]);
      }
    } else {
      const newP = await pool.query(
        `INSERT INTO providers (provider_key, display_name, base_url, enabled, priority)
         VALUES ($1, $2, $3, true, 5)
         RETURNING id`,
        [platform, platform.toUpperCase(), baseUrl]
      );
      providerId = newP.rows[0].id;
    }

    // 2. Encrypt credential value
    const enc = encrypt(key);
    const keyless = key.trim().length === 0;

    const credRes = await pool.query(
      `INSERT INTO credentials (
         provider_id, credential_name, encrypted_value, iv, auth_tag,
         credential_type, enabled, priority, model_scope, group_label
       )
       VALUES ($1, $2, $3, $4, $5, $6, true, 0, $7, $8)
       RETURNING id, created_at`,
      [
        providerId,
        label,
        enc.encrypted,
        enc.iv,
        enc.authTag,
        keyless ? 'keyless' : 'api_key',
        modelScope ? JSON.stringify(modelScope) : null,
        groupLabel || null,
      ]
    );

    const credId = credRes.rows[0].id;
    await pool.query(
      `INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, group_label, status, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'healthy', 1)
       ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, encrypted_key = EXCLUDED.encrypted_key, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag`,
      [credId, platform, label, enc.encrypted, enc.iv, enc.authTag, groupLabel || null]
    ).catch(() => {});

    // Atomically reload in-memory routing registry
    await reloadRoutingRegistry();

    res.status(201).json({
      id: credRes.rows[0].id,
      platform,
      label,
      groupLabel: groupLabel || null,
      maskedKey: maskKey(key),
      enabled: true,
      keyless,
      createdAt: new Date(credRes.rows[0].created_at).toISOString(),
    });
  } catch (err: any) {
    console.error('[keys] Error adding key:', err);
    res.status(500).json({ error: 'Failed to add API key' });
  }
});

// Helper for updating credential by ID
async function handleUpdateKey(req: Request, res: Response) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid key ID' });
      return;
    }

    const parsed = updateKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid update payload: ' + parsed.error.message });
      return;
    }

    const { enabled, label, modelScope, groupLabel, key } = parsed.data;
    const pool = getPostgresPool();

    const updates: string[] = ['updated_at = NOW()'];
    const values: any[] = [];
    let idx = 1;

    if (enabled !== undefined) {
      updates.push(`enabled = $${idx++}`);
      values.push(enabled);
    }
    if (label !== undefined) {
      updates.push(`credential_name = $${idx++}`);
      values.push(label);
    }
    if (modelScope !== undefined) {
      updates.push(`model_scope = $${idx++}`);
      values.push(modelScope ? JSON.stringify(modelScope) : null);
    }
    if (groupLabel !== undefined) {
      updates.push(`group_label = $${idx++}`);
      values.push(groupLabel || null);
    }
    if (key !== undefined) {
      const enc = encrypt(key);
      updates.push(`encrypted_value = $${idx++}`);
      values.push(enc.encrypted);
      updates.push(`iv = $${idx++}`);
      values.push(enc.iv);
      updates.push(`auth_tag = $${idx++}`);
      values.push(enc.authTag);
    }

    values.push(id);
    await pool.query(
      `UPDATE credentials SET ${updates.join(', ')} WHERE id = $${idx}`,
      values
    );

    await reloadRoutingRegistry();
    res.json({ success: true, id });
  } catch (err: any) {
    console.error('[keys] Error updating key:', err);
    res.status(500).json({ error: 'Failed to update API key' });
  }
}

// 3. PUT /api/keys/:id - Update credential
keysRouter.put('/:id', handleUpdateKey);

// 3b. PATCH /api/keys/:id - Update credential
keysRouter.patch('/:id', handleUpdateKey);

// 4. POST /api/keys/:id/rotate - Rotate credential key
keysRouter.post('/:id/rotate', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const parsed = rotateKeySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'New key is required' });
      return;
    }

    const enc = encrypt(parsed.data.key);
    const pool = getPostgresPool();

    const updateRes = await pool.query(
      `UPDATE credentials
       SET encrypted_value = $1, iv = $2, auth_tag = $3, cooldown_until = NULL, updated_at = NOW()
       WHERE id = $4
       RETURNING id`,
      [enc.encrypted, enc.iv, enc.authTag, id]
    );

    if (updateRes.rowCount === 0) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }

    await reloadRoutingRegistry();
    res.json({ success: true, id });
  } catch (err: any) {
    console.error('[keys] Error rotating key:', err);
    res.status(500).json({ error: 'Failed to rotate key' });
  }
});

// 5. DELETE /api/keys/:id - Delete credential
keysRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const pool = getPostgresPool();

    const delRes = await pool.query('DELETE FROM credentials WHERE id = $1 RETURNING id', [id]);
    if (delRes.rowCount === 0) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }

    await pool.query('DELETE FROM api_keys WHERE id = $1', [id]).catch(() => {});
    await reloadRoutingRegistry();
    res.json({ success: true, id });
  } catch (err: any) {
    console.error('[keys] Error deleting key:', err);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

// DELETE /api/keys/:id/cooldowns - Reset cooldowns for key
keysRouter.delete('/:id/cooldowns', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const pool = getPostgresPool();
    await pool.query('UPDATE credentials SET cooldown_until = NULL WHERE id = $1', [id]);
    await reloadRoutingRegistry();
    res.json({ success: true, id });
  } catch (err: any) {
    console.error('[keys] Error clearing cooldowns:', err);
    res.status(500).json({ error: 'Failed to clear cooldowns' });
  }
});

// PATCH /api/keys/platform/:platform - Enable/disable all keys for a platform
keysRouter.patch('/platform/:platform', async (req: Request, res: Response) => {
  try {
    const platform = req.params.platform;
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled boolean is required' });
      return;
    }
    const pool = getPostgresPool();
    await pool.query(
      `UPDATE credentials SET enabled = $1, updated_at = NOW()
       WHERE provider_id IN (SELECT id FROM providers WHERE provider_key = $2)`,
      [enabled, platform]
    );
    await reloadRoutingRegistry();
    res.json({ success: true, platform, enabled });
  } catch (err: any) {
    console.error('[keys] Error updating platform keys:', err);
    res.status(500).json({ error: 'Failed to update platform keys' });
  }
});

// 6. POST /api/keys/:id/test - Test key validity live
keysRouter.post('/:id/test', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const pool = getPostgresPool();

    const queryRes = await pool.query(`
      SELECT c.id, c.encrypted_value, c.iv, c.auth_tag, p.provider_key
      FROM credentials c
      JOIN providers p ON p.id = c.provider_id
      WHERE c.id = $1
    `, [id]);

    if (queryRes.rows.length === 0) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }

    const row = queryRes.rows[0];
    const platform = row.provider_key as Platform;
    const plaintext = decrypt(row.encrypted_value, row.iv, row.auth_tag);

    if (!hasProvider(platform)) {
      res.json({ valid: true, message: 'Provider registered without live validation probe.' });
      return;
    }

    const adapter = getProvider(platform);
    if (!adapter) {
      res.json({ valid: true, message: 'Provider adapter not found, key saved.' });
      return;
    }

    const validationResult = await adapter.validateKey(plaintext);

    if (typeof validationResult === 'boolean') {
      res.json({ valid: validationResult, message: validationResult ? 'Key is valid and working.' : 'Key validation failed.' });
    } else if (validationResult && !validationResult.valid) {
      res.json({ valid: false, error: validationResult.error });
    } else {
      res.json({ valid: true, message: 'Key is valid.' });
    }
  } catch (err: any) {
    console.error('[keys] Error testing key:', err);
    res.status(500).json({ valid: false, error: err?.message || 'Testing failed' });
  }
});

interface CustomEndpointRef {
  baseUrl: string;
  keyId: number | null;
  storedKey: string | null;
}

async function rejectUnsafeBaseUrl(baseUrl: string, res: Response): Promise<boolean> {
  const verdict = await assessProviderUrl(baseUrl);
  if (verdict.allowed) return false;
  res.status(400).json({ error: { message: `baseUrl rejected: ${verdict.reason}` } });
  return true;
}

function resolveEndpointRef(ref: { keyId?: number; baseUrl?: string }): CustomEndpointRef {
  const db = getDb();
  const requestedBaseUrl = ref.baseUrl === undefined ? undefined : normalizeBaseUrl(ref.baseUrl);

  if (ref.keyId !== undefined) {
    const row = db.prepare('SELECT id, platform, base_url, encrypted_key, iv, auth_tag FROM api_keys WHERE id = ?')
      .get(ref.keyId) as { id: number; platform: string; base_url: string | null; encrypted_key: string; iv: string; auth_tag: string } | undefined;
    if (!row || row.platform !== 'custom' || !row.base_url) {
      throw Object.assign(new Error('keyId does not name a custom endpoint'), { status: 400 });
    }
    if (requestedBaseUrl !== undefined && requestedBaseUrl !== row.base_url) {
      throw Object.assign(new Error('baseUrl does not match the endpoint keyId belongs to'), { status: 400 });
    }
    let storedKey: string | null = null;
    try {
      storedKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    } catch { /* an undecryptable row still names the endpoint */ }
    return { baseUrl: row.base_url, keyId: row.id, storedKey };
  }

  if (!requestedBaseUrl) {
    throw Object.assign(new Error('baseUrl or keyId is required'), { status: 400 });
  }

  const rows = db.prepare(`
    SELECT id, encrypted_key, iv, auth_tag FROM api_keys
     WHERE platform = 'custom' AND base_url = ? ORDER BY id
  `).all(requestedBaseUrl) as Array<{ id: number; encrypted_key: string; iv: string; auth_tag: string }>;
  for (const row of rows) {
    try {
      return { baseUrl: requestedBaseUrl, keyId: row.id, storedKey: decrypt(row.encrypted_key, row.iv, row.auth_tag) };
    } catch { /* try the next credential */ }
  }
  return { baseUrl: requestedBaseUrl, keyId: rows[0]?.id ?? null, storedKey: null };
}

const discoverModelsSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL').optional(),
  keyId: z.number().int().positive().optional(),
  apiKey: z.string().optional(),
}).refine(
  d => d.baseUrl !== undefined || d.keyId !== undefined,
  { message: 'baseUrl or keyId is required' },
);

keysRouter.post('/custom/discover-models', async (req: Request, res: Response) => {
  const parsed = discoverModelsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  let endpoint: CustomEndpointRef;
  try {
    endpoint = resolveEndpointRef(parsed.data);
  } catch (err: any) {
    res.status(err.status ?? 400).json({ error: { message: err.message } });
    return;
  }

  if (await rejectUnsafeBaseUrl(endpoint.baseUrl, res)) return;

  const apiKey = parsed.data.apiKey?.trim() || endpoint.storedKey || 'no-key';

  try {
    const discovered = await discoverEndpointModels(endpoint.baseUrl, apiKey);

    const db = getDb();
    const registeredIds = new Set<string>();
    if (endpoint.keyId != null) {
      const poolIds = [...customEndpointKeyIds(db, endpoint.keyId)];
      if (poolIds.length > 0) {
        const placeholders = poolIds.map(() => '?').join(', ');
        const rows = db.prepare(
          `SELECT model_id FROM models WHERE platform = 'custom' AND key_id IN (${placeholders})`,
        ).all(...poolIds) as { model_id: string }[];
        for (const row of rows) registeredIds.add(row.model_id);
      }
    }

    const models = discovered.map(m => ({ ...m, registered: registeredIds.has(m.id) }));
    res.json({
      baseUrl: endpoint.baseUrl,
      keyId: endpoint.keyId,
      models,
      total: models.length,
      registeredCount: models.filter(m => m.registered).length,
    });
  } catch (err: any) {
    if (err instanceof ModelDiscoveryError) {
      res.status(err.status).json({ error: { message: err.message, type: 'upstream_error' } });
      return;
    }
    res.status(502).json({ error: { message: `Model discovery failed: ${err?.message ?? 'unknown error'}` } });
  }
});

const modelEntrySchema = z.union([
  z.string().min(1),
  z.object({
    model: z.string().min(1),
    displayName: z.string().optional(),
    supportsTools: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
  }),
]);

const customProviderSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL').optional(),
  keyId: z.number().int().positive().optional(),
  model: z.string().optional(),
  models: z.array(modelEntrySchema).optional(),
  displayName: z.string().optional(),
  apiKey: z.string().optional(),
  label: z.string().optional(),
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  groupLabel: z.string().trim().max(80).optional(),
}).refine(
  d => d.baseUrl !== undefined || d.keyId !== undefined,
  { message: 'baseUrl or keyId is required' },
);

keysRouter.post('/custom', async (req: Request, res: Response) => {
  const parsed = customProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  let endpoint: CustomEndpointRef;
  try {
    endpoint = resolveEndpointRef(parsed.data);
  } catch (err: any) {
    res.status(err.status ?? 400).json({ error: { message: err.message } });
    return;
  }
  const baseUrl = endpoint.baseUrl;

  if (await rejectUnsafeBaseUrl(baseUrl, res)) return;

  const providedKey = parsed.data.apiKey?.trim() || undefined;
  const label = parsed.data.label?.trim() || undefined;

  const topTools = parsed.data.supportsTools;
  const topVision = parsed.data.supportsVision;
  const entries: { modelId: string; displayName: string | null; supportsTools?: boolean; supportsVision?: boolean }[] = [];
  const seen = new Set<string>();
  const addEntry = (rawId: string, rawDisplay?: string, tools?: boolean, vision?: boolean) => {
    const modelId = rawId.trim();
    if (!modelId || seen.has(modelId)) return;
    seen.add(modelId);
    entries.push({
      modelId,
      displayName: rawDisplay?.trim() || null,
      supportsTools: tools ?? topTools,
      supportsVision: vision ?? topVision,
    });
  };
  if (parsed.data.model?.trim()) addEntry(parsed.data.model, parsed.data.displayName);
  for (const m of parsed.data.models ?? []) {
    if (typeof m === 'string') addEntry(m);
    else addEntry(m.model, m.displayName, m.supportsTools, m.supportsVision);
  }
  const soleName = parsed.data.displayName?.trim();
  if (soleName && !parsed.data.model?.trim() && entries.length === 1 && entries[0]!.displayName === null) {
    entries[0]!.displayName = soleName;
  }

  const db = getDb();

  if (entries.length === 0) {
    if (!providedKey) {
      res.status(400).json({ error: { message: 'model or models is required' } });
      return;
    }
    if (endpoint.keyId === null) {
      res.status(400).json({ error: { message: 'model or models is required to register a new endpoint' } });
      return;
    }
    if (endpointHasCredential(db, baseUrl, providedKey)) {
      res.status(409).json({ error: { message: 'this endpoint already has that key' } });
      return;
    }
    const added = resolveCustomEndpointKey(db, baseUrl, providedKey, label, endpoint.keyId);
    if (parsed.data.groupLabel !== undefined) setCustomEndpointGroup(db, added.keyId, normalizeGroupLabel(parsed.data.groupLabel));
    res.status(added.created ? 201 : 200).json({
      success: true,
      keyId: added.keyId,
      platform: 'custom',
      baseUrl,
      models: [],
      created: 0,
      alreadyRegistered: 0,
      maskedKey: maskKey(added.storedKey),
    });
    return;
  }

  const overridden = (e: typeof entries[number]) => e.supportsTools !== undefined || e.supportsVision !== undefined;
  const kindOf = (e: typeof entries[number]) => overridden(e) ? undefined : classifyModelId(e.modelId);
  const chatEntries = entries.filter(e => kindOf(e) === undefined || kindOf(e) === 'embedding');
  const embedEntries = chatEntries.filter(e => kindOf(e) === 'embedding');
  const pureChatEntries = chatEntries.filter(e => kindOf(e) !== 'embedding');
  const mediaEntries = entries.filter(e => {
    const kind = kindOf(e);
    return kind === 'image' || kind === 'audio' || kind === 'transcription';
  });

  const { keyId, storedKey, registered } = registerCustomModels(
    db, baseUrl, providedKey, label, endpoint.keyId ?? undefined, pureChatEntries,
  );
  if (parsed.data.groupLabel !== undefined) setCustomEndpointGroup(db, keyId, normalizeGroupLabel(parsed.data.groupLabel));

  const mediaRegistered: Array<{ modelDbId: number; model: string; modality: string; created: boolean }> = [];
  const perModelErrors: Array<{ model: string; error: string }> = [];
  for (const e of mediaEntries) {
    try {
      mediaRegistered.push(db.transaction(() => registerCustomMediaModel(db, keyId, {
        modelId: e.modelId,
        displayName: e.displayName,
        modality: kindOf(e) as 'image' | 'audio' | 'transcription',
      }))());
    } catch (err: any) {
      perModelErrors.push({ model: e.modelId, error: err?.message ?? 'media registration failed' });
    }
  }

  const embeddingsRegistered: Array<{ model: string }> = [];
  for (const e of embedEntries) {
    try {
      const existing = db.prepare(
        "SELECT dimensions FROM embedding_models WHERE platform = 'custom' AND model_id = ?",
      ).get(e.modelId) as { dimensions: number } | undefined;
      const dimensions = existing?.dimensions ?? await probeEmbeddingDimensions(baseUrl, providedKey ?? storedKey, e.modelId);
      registerCustomEmbeddingModel(db, {
        keyId,
        modelId: e.modelId,
        displayName: e.displayName,
        family: e.modelId,
        dimensions,
        maxInputTokens: null,
        quotaLabel: 'custom endpoint',
      });
      embeddingsRegistered.push({ model: e.modelId });
    } catch (err: any) {
      perModelErrors.push({ model: e.modelId, error: err?.message ?? 'embedding registration failed' });
    }
  }

  await reloadRoutingRegistry().catch(() => {});

  const first = registered[0];
  res.status(201).json({
    success: true,
    keyId,
    platform: 'custom',
    baseUrl,
    model: first?.model,
    displayName: first?.displayName,
    modelDbId: first?.modelDbId,
    models: registered.map(r => ({
      modelDbId: r.modelDbId,
      model: r.model,
      displayName: r.displayName,
      supportsTools: r.supportsTools,
      supportsVision: r.supportsVision,
      created: r.created,
    })),
    mediaModels: mediaRegistered,
    embeddingModels: embeddingsRegistered,
    created: registered.filter(r => r.created).length + mediaRegistered.filter(r => r.created).length,
    alreadyRegistered: registered.filter(r => !r.created).length + mediaRegistered.filter(r => !r.created).length,
    maskedKey: maskKey(storedKey),
    errors: perModelErrors.length > 0 ? perModelErrors : undefined,
  });
});

const probeModelsSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL').optional(),
  keyId: z.number().int().positive().optional(),
  apiKey: z.string().optional(),
}).refine(
  d => d.baseUrl !== undefined || d.keyId !== undefined,
  { message: 'baseUrl or keyId is required' },
);

keysRouter.post('/custom/probe', async (req: Request, res: Response) => {
  const parsed = probeModelsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  let endpoint: CustomEndpointRef;
  try {
    endpoint = resolveEndpointRef(parsed.data);
  } catch (err: any) {
    res.status(err.status ?? 400).json({ error: { message: err.message } });
    return;
  }

  if (await rejectUnsafeBaseUrl(endpoint.baseUrl, res)) return;

  const apiKey = parsed.data.apiKey?.trim() || endpoint.storedKey || 'no-key';

  let registeredModelId: string | null = null;
  let poolIds: number[] = [];
  if (endpoint.keyId != null) {
    const db = getDb();
    poolIds = [...customEndpointKeyIds(db, endpoint.keyId)];
    const placeholders = poolIds.map(() => '?').join(', ');
    const row = db.prepare(
      `SELECT model_id FROM models WHERE platform = 'custom' AND key_id IN (${placeholders}) ORDER BY id LIMIT 1`,
    ).get(...poolIds) as { model_id: string } | undefined;
    registeredModelId = row?.model_id ?? null;
  }

  try {
    const probe = await probeEndpointModel(endpoint.baseUrl, apiKey, registeredModelId);

    if (endpoint.keyId != null) {
      getDb().prepare(`
        INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms, request_type)
        VALUES ('custom', ?, ?, 'success', ?, ?, ?, ?, 'chat')
      `).run(probe.modelId, endpoint.keyId, probe.inputTokens, probe.outputTokens, probe.latencyMs, probe.latencyMs);

      clearCooldownsForKey(endpoint.keyId);
    }

    if (probe.toolCalls && poolIds.length > 0) {
      const placeholders = poolIds.map(() => '?').join(', ');
      getDb().prepare(
        `UPDATE models SET supports_tools = 1
          WHERE platform = 'custom' AND model_id = ? AND key_id IN (${placeholders})`,
      ).run(probe.modelId, ...poolIds);
    }

    res.json({
      modelId: probe.modelId,
      latencyMs: probe.latencyMs,
      ...(probe.reasoning !== undefined ? { reasoning: probe.reasoning } : {}),
      ...(probe.toolCalls !== undefined ? { toolCalls: probe.toolCalls } : {}),
    });
  } catch (err: any) {
    if (err instanceof ModelDiscoveryError) {
      res.status(err.status).json({ error: { message: err.message, type: 'upstream_error' } });
      return;
    }
    res.status(502).json({ error: { message: `Probe failed: ${err?.message ?? 'unknown error'}` } });
  }
});
