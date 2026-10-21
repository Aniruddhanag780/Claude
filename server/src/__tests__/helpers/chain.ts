import { getDb } from '../../db/index.js';
import { getActiveProfileId } from '../../services/profile-models.js';

/**
 * Put a model in the active fallback chain, the way a catalog sync does.
 *
 * A fixture that seeds `models` + `fallback_config` by hand has only built half
 * an install: on a real one every catalog model is mirrored into the active
 * profile's chain (services/profile-models.ts), and that chain — not the global
 * table — is what the router walks (#1021). No-op when nothing is active, which
 * is the legacy shape where `fallback_config` IS the chain.
 */
export async function addToActiveChain(modelDbId: number, priority: number, enabled = true): Promise<void> {
  const db = getDb();
  const profileId = await getActiveProfileId(db);
  if (profileId == null) return;
  await db.run(`
    INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(profile_id, model_db_id) DO UPDATE SET priority = excluded.priority, enabled = excluded.enabled
  `, [profileId, modelDbId, priority, enabled ? 1 : 0]);
}
