import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { reserveMonthlyBudget } from './key-budget.js';
import { getActiveRegistry } from './router-registry.js';

export interface ReservedProviderCredential {
  id: number;
  key: string;
  baseUrl: string | null;
  release: () => void;
}

interface KeyRow {
  id: number;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  base_url: string | null;
}

/** Select and reserve a credential for the independent embeddings/media routers.
 * Bound custom models stay on their own key; ordinary providers may use any
 * healthy key with room in its budget. Callers release after logging the result.
 *
 * ponytail: monthly caps bind the registry lane (credentials rows) only; this
 * api_keys path reads ids from the legacy key table, so a fresh corporate
 * lane-B key runs uncapped unless the migration script mirrored it. Mirror cap
 * columns into api_keys in migration 009 if lane-B budgeting needs them.
 */
export async function reserveProviderCredential(
  row: { platform: string; key_id: number | null },
  estimatedTokens: number,
  skip: (keyId: number) => boolean = () => false,
): Promise<{ credential: ReservedProviderCredential | null; budgetBlocked: boolean }> {
  if (row.platform === 'custom' && row.key_id == null) return { credential: null, budgetBlocked: false };
  const bound = row.key_id != null;
  const keys = ((await getDb().query(`
    SELECT id, encrypted_key, iv, auth_tag, base_url FROM api_keys
    WHERE ${bound ? 'id' : 'platform'} = $1 AND enabled = 1
      AND status IN ('healthy', 'unknown') ORDER BY RANDOM()
  `, [bound ? row.key_id : row.platform]))?.rows as KeyRow[] | undefined) ?? [];
  let budgetBlocked = false;
  for (const keyRow of keys) {
    if (skip(keyRow.id)) continue;
    let key: string;
    try {
      key = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
    } catch {
      continue;
    }
    const reservation = reserveMonthlyBudget(keyRow.id, estimatedTokens);
    if (!reservation.allowed) { budgetBlocked = true; continue; }
    return {
      credential: {
        id: keyRow.id, key,
        baseUrl: keyRow.base_url?.trim().replace(/\/+$/, '') ?? null,
        release: reservation.release,
      },
      budgetBlocked,
    };
  }

  // Fallback to active router registry in production if api_keys table is empty
  const registryCreds = getActiveRegistry()?.getAllCredentials() ?? [];
  const matching = bound
    ? registryCreds.filter(c => c.id === row.key_id && c.enabled && !c.runtime.lastHealthError)
    : registryCreds.filter(c => c.providerKey === row.platform && c.enabled && !c.runtime.lastHealthError);

  for (const cred of matching) {
    if (skip(cred.id)) continue;
    const reservation = reserveMonthlyBudget(cred.id, estimatedTokens);
    if (!reservation.allowed) { budgetBlocked = true; continue; }
    const prov = getActiveRegistry().getAllProviders().find((p: { id: number; baseUrl?: string | null }) => p.id === cred.providerId);
    return {
      credential: {
        id: cred.id,
        key: cred.decryptedKey,
        baseUrl: prov?.baseUrl?.trim().replace(/\/+$/, '') ?? null,
        release: reservation.release,
      },
      budgetBlocked,
    };
  }

  return { credential: null, budgetBlocked };
}
