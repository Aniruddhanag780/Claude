// Keep user-deleted custom models deleted across the scheduled model sync.
//
// Issue #926: catalog-managed models carry a tombstone so catalog-sync never
// resurrects a model the user deleted. The scheduled custom-model sync
// (services/custom-model-sync.ts) had no equivalent, so deleting a custom
// relay's model (or its whole endpoint key) was undone by the next sync pass:
// the sync only checks whether the model id is still present in the `models`
// table, and treats a deletion as "new" again.
//
// This module holds the same contract for custom rows, keyed by
// (endpoint_scope, model_id) — the exact identity a custom model row has today
// (#651), so deleting a model on one relay never suppresses the identical id
// on another. A tombstone is "keep it deleted" and is cleared the moment the
// operator EXPLICITLY re-registers that model on the same endpoint.

import type { Db } from '../db/types.js';

export async function recordCustomModelTombstone(
  db: Db,
  endpointScope: string,
  modelId: string,
): Promise<void> {
  await db.run(`
    INSERT INTO custom_model_tombstones (endpoint_scope, model_id)
    VALUES (?, ?)
    ON CONFLICT(endpoint_scope, model_id)
    DO UPDATE SET created_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')
  `, [endpointScope, modelId]);
}

export async function isCustomModelTombstoned(
  db: Db,
  endpointScope: string,
  modelId: string,
): Promise<boolean> {
  return await db.get('SELECT 1 FROM custom_model_tombstones WHERE endpoint_scope = ? AND model_id = ?', [endpointScope, modelId]) !== undefined;
}

export async function clearCustomModelTombstone(
  db: Db,
  endpointScope: string,
  modelId: string,
): Promise<void> {
  await db.run('DELETE FROM custom_model_tombstones WHERE endpoint_scope = ? AND model_id = ?', [endpointScope, modelId]);
}
