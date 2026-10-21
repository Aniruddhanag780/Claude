import type { Db } from '../db/types.js';
import { resolveCustomEndpointKey, customEndpointKeyIds } from './custom-endpoint.js';
import { customModelSeed } from './custom-model-seed.js';
import { ensureModelInProfiles } from './profile-models.js';
import { clearCustomModelTombstone } from './custom-model-tombstone.js';
import { endpointScopeForBaseUrl } from '../lib/endpoint-scope.js';

// ── Shared custom-model registration ─────────────────────────────────────────
//
// POST /custom, the bulk key importer (#382) and the scheduled custom-model
// sync (#674/#663/#656) register models against a user's own endpoint through
// the SAME code path, so they can never drift apart. This used to live inline
// in routes/keys.ts; it moved here verbatim and the copy there was deleted, so
// no caller can invent a subtly different notion of "registering a custom
// model".

/** One model to register against a custom endpoint (POST /custom body entry). */
export interface CustomModelEntry {
  modelId: string;
  displayName: string | null;
  supportsTools?: boolean;
  supportsVision?: boolean;
}

export interface RegisteredCustomModel {
  modelDbId: number;
  model: string;
  displayName: string;
  supportsTools: boolean;
  supportsVision: boolean;
  created: boolean;
}

export interface RegisterCustomModelsResult {
  keyId: number;
  /** The credential this registration bound to, for masking in responses. */
  storedKey: string;
  registered: RegisteredCustomModel[];
}

/**
 * Register (or re-register) models against a custom endpoint inside one
 * transaction.
 *
 * Key rows are matched on (base_url, secret): a new secret for a known
 * endpoint is a SECOND credential for it, not a replacement (#619), and a
 * new base_url is a separate provider (#212). Identity is per endpoint
 * (#651): the same model id on a DIFFERENT relay is a separate row with its
 * own enabled flag, ranks and stats, instead of silently rebinding the other
 * endpoint's row. A model already on THIS endpoint keeps the key it has, so
 * adding a second credential doesn't re-bind it (#619).
 *
 * Capability flags: an unset flag binds NULL so COALESCE picks the insert
 * default (tools 1, vision 0) on a new row and preserves the existing value
 * on re-registration (#470). An omitted display name binds NULL the same way
 * — it falls back to the model id on a new row and leaves a name already on
 * the row alone, so the bulk re-registration behind "Fetch models" (which
 * posts bare ids) can't wipe names the operator set.
 */
export async function registerCustomModels(
  db: Db,
  baseUrl: string,
  providedKey: string | undefined,
  label: string | undefined,
  pinnedKeyId: number | undefined,
  entries: CustomModelEntry[],
): Promise<RegisterCustomModelsResult> {
  return await db.transaction(async () => {
    const { keyId, storedKey } = await resolveCustomEndpointKey(db, baseUrl, providedKey, label, pinnedKeyId);
    const registered = await registerCustomChatModels(db, baseUrl, keyId, entries);
    return { keyId, storedKey, registered };
  });
}

/**
 * The registration loop itself, against an ALREADY-resolved endpoint key and
 * inside the caller's transaction. Split out from registerCustomModels so the
 * bulk key importer (#382) — which resolves its own key and owns a wider
 * transaction — shares this exact write path instead of keeping a second copy.
 */
export async function registerCustomChatModels(
  db: Db,
  baseUrl: string,
  keyId: number,
  entries: CustomModelEntry[],
): Promise<RegisteredCustomModel[]> {
  const endpointKeyIds = await customEndpointKeyIds(db, keyId);
  // The identity discriminator for every row registered in this call (#651).
  const endpointScope = endpointScopeForBaseUrl(baseUrl);
  // Unknown ≠ worst: seed the routing ranks at the catalog median so a new
  // custom model is explored instead of buried at intelligence 0 (#488).
  const seed = await customModelSeed(db);

  const registered: RegisteredCustomModel[] = [];
  for (const { modelId, displayName, supportsTools, supportsVision } of entries) {
    // #926: this is an EXPLICIT registration (POST /custom, bulk importer or
    // the dashboard's "Fetch models" submit), so it overrides a previous
    // deletion. The scheduled sync never reaches this loop for a tombstoned
    // model — it filters them out in custom-model-sync.ts — so the tombstone
    // can only be lifted here by a human choosing to re-add the model.
    await clearCustomModelTombstone(db, endpointScope, modelId);
    const bound = await db.get("SELECT key_id FROM models WHERE platform = 'custom' AND model_id = ? AND endpoint_scope = ?", [modelId, endpointScope]) as { key_id: number | null } | undefined;
    const created = bound === undefined;
    const bindKeyId = bound?.key_id != null && endpointKeyIds.has(bound.key_id) ? bound.key_id : keyId;
    const toolsParam = supportsTools === undefined ? null : (supportsTools ? 1 : 0);
    const visionParam = supportsVision === undefined ? null : (supportsVision ? 1 : 0);
    // The seed applies on INSERT only: DO UPDATE deliberately leaves the rank
    // columns alone so re-registering a model (or bulk-adding alongside it)
    // never rewrites ranks the operator has since tuned by hand.
    await db.run(`
      INSERT INTO models
        (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
         rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled, key_id,
         supports_tools, supports_vision, source, endpoint_scope)
      VALUES ('custom', $1, COALESCE($2, $1), $3, $4, $5,
         NULL, NULL, NULL, NULL, '', NULL, 1, $6,
         COALESCE($7, 1), COALESCE($8, 0), 'user', $9)
      ON CONFLICT(platform, model_id, endpoint_scope)
      DO UPDATE SET
        display_name = COALESCE($2, models.display_name),
        key_id = excluded.key_id,
        enabled = 1,
        supports_tools = COALESCE($7, models.supports_tools),
        supports_vision = COALESCE($8, models.supports_vision)
    `, [modelId, displayName, seed.intelligenceRank, seed.speedRank, seed.sizeLabel, bindKeyId, toolsParam, visionParam, endpointScope]);

    // Read back rather than echo the submitted values: an omitted display name
    // or capability flag resolves in SQL, so the row is the only place that
    // knows what this model is actually called now.
    const modelRow = await db.get("SELECT id, display_name, supports_tools, supports_vision FROM models WHERE platform = 'custom' AND model_id = ? AND endpoint_scope = ?", [modelId, endpointScope]) as { id: number; display_name: string; supports_tools: number; supports_vision: number };

    // Append to the fallback chain if not already present.
    const inChain = await db.get('SELECT 1 FROM fallback_config WHERE model_db_id = ?', [modelRow.id]);
    if (!inChain) {
      const max = await db.get('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config') as { m: number };
      await db.run('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)', [modelRow.id, max.m + 1]);
    }
    await ensureModelInProfiles(db, modelRow.id);

    registered.push({
      modelDbId: modelRow.id,
      model: modelId,
      displayName: modelRow.display_name,
      supportsTools: modelRow.supports_tools === 1,
      supportsVision: modelRow.supports_vision === 1,
      created,
    });
  }

  return registered;
}
