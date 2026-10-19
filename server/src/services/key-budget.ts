/**
 * Per-credential monthly budget (#1158): optional request/token caps per
 * credentials row, enforced against the CURRENT UTC month's successful
 * requests. A key at its cap returns `quota_exceeded` (429) with a Retry-After
 * of "seconds until the next month" — the semantic GateLLM-style rejection so
 * an agent knows when the window resets instead of hammering a 429.
 *
 * Successful usage is settled in key_monthly_usage independently of analytics
 * retention (migration 008). Active requests reserve their estimated tokens
 * until their route is released. Token estimates are an admission guard, not
 * an exact upstream billing cap. Caps are opt-in (0 = unlimited) and reset on
 * UTC month boundaries.
 *
 * The registry (router-registry.ts) now serves rows from `credentials`, so
 * caps/ledger are keyed by credential id — the SQLite-era `api_keys` ids no
 * longer match the routing flow.
 */
import { getDb } from '../db/index.js';

export interface MonthlyBudgetCaps {
  /** 0 = unlimited (the default, unchanged behaviour). */
  requestCap: number;
  /** 0 = unlimited. */
  tokenCap: number;
}

export interface MonthlyUsage {
  /** Successful requests in the current UTC month. */
  requests: number;
  /** Sum of (input_tokens + output_tokens) over those successes. */
  tokens: number;
}

export type BudgetVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'monthly_request_cap' | 'monthly_token_cap'; retryAfterSec: number };

function utcNextMonthStartMs(now = Date.now()): number {
  const d = new Date(now);
  const month = d.getUTCMonth() + 1;
  return Date.UTC(d.getUTCFullYear() + Math.floor(month / 12), month % 12, 1);
}

function monthKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

interface Reservation { keyId: number; tokens: number; }
// Keyed by the pool instance (a new mock pool per test run) so reservations
// never leak across test re-initializations.
const reservations = new WeakMap<object, Set<Reservation>>();

function activeReservations(): Set<Reservation> {
  const db = getDb();
  let active = reservations.get(db);
  if (!active) { active = new Set(); reservations.set(db, active); }
  return active;
}

export function getMonthlyBudgetCaps(keyId: number): MonthlyBudgetCaps {
  if (!Number.isFinite(keyId)) return { requestCap: 0, tokenCap: 0 };
  try {
    const db = getDb();
    if (typeof db.prepare === 'function') {
      const row = db.prepare(
        'SELECT monthly_request_cap, monthly_token_cap FROM api_keys WHERE id = ?',
      ).get(keyId) as { monthly_request_cap?: number; monthly_token_cap?: number } | undefined;
      if (row) {
        return {
          requestCap: Number(row.monthly_request_cap ?? 0),
          tokenCap: Number(row.monthly_token_cap ?? 0),
        };
      }
    }
  } catch {
    // Falls through to default
  }
  return { requestCap: 0, tokenCap: 0 };
}

export function setMonthlyBudgetCaps(
  keyId: number,
  patch: Partial<MonthlyBudgetCaps>,
): boolean {
  if (!Number.isFinite(keyId)) return false;
  const sets: string[] = [];
  const values: number[] = [];
  if (patch.requestCap !== undefined) {
    sets.push('monthly_request_cap = ?');
    values.push(patch.requestCap);
  }
  if (patch.tokenCap !== undefined) {
    sets.push('monthly_token_cap = ?');
    values.push(patch.tokenCap);
  }
  if (sets.length === 0) return false;
  let changed = false;
  try {
    const db = getDb();
    if (typeof db.prepare === 'function') {
      const result = db.prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ?`).run(...values, keyId);
      changed = (result?.changes ?? 0) > 0;
    }
  } catch {
    // ignore
  }
  return changed;
}

export function getMonthlyUsage(keyId: number, now = Date.now()): MonthlyUsage {
  if (!Number.isFinite(keyId)) return { requests: 0, tokens: 0 };
  try {
    const db = getDb();
    if (typeof db.prepare === 'function') {
      const row = db.prepare(`
        SELECT requests, tokens FROM key_monthly_usage WHERE key_id = ? AND month = ?
      `).get(keyId, monthKey(now)) as MonthlyUsage | undefined;
      if (row) {
        return { requests: Number(row?.requests ?? 0), tokens: Number(row?.tokens ?? 0) };
      }
      const monthStart = `${monthKey(now)}-01 00:00:00`;
      const reqRow = db.prepare(`
        SELECT COUNT(*) as requests, COALESCE(SUM(input_tokens + output_tokens), 0) as tokens
        FROM requests
        WHERE key_id = ? AND status = 'success' AND created_at >= ?
      `).get(keyId, monthStart) as any;
      if (reqRow && Number(reqRow.requests ?? reqRow.c ?? 0) > 0) {
        return {
          requests: Number(reqRow.requests ?? reqRow.c ?? 0),
          tokens: Number(reqRow.tokens ?? 0),
        };
      }
    }
  } catch {
    // ignore
  }
  return { requests: 0, tokens: 0 };
}

/**
 * Settle one successful request into the ledger. Called from the request-log
 * and request-insert funnels after a success; failures never settle. An
 * insert-or-increment upsert, so parallel streams converge on the same row
 * with native Postgres integer arithmetic.
 */
export async function settleMonthlyUsage(keyId: number, tokens: number, now = Date.now()): Promise<void> {
  if (!Number.isFinite(keyId)) return;
  try {
    await getDb().query(
      `INSERT INTO key_monthly_usage (key_id, month, requests, tokens)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (key_id, month) DO UPDATE
       SET requests = key_monthly_usage.requests + 1,
           tokens = key_monthly_usage.tokens + EXCLUDED.tokens`,
      [keyId, monthKey(now), Math.max(0, tokens)],
    );
  } catch (err) {
    // Ledger bookkeeping must never surface into the response path; an
    // occasional dropped settle only loosens the guard until the next month.
    console.error('[key-budget] failed to settle monthly usage:', err);
  }
}

/**
 * Check a key against its monthly caps, taking the current month's successful
 * usage plus the tokens THIS request would add. Returns allowed when both caps
 * are 0 (unlimited) or neither would be exceeded.
 */
export function checkMonthlyBudget(
  keyId: number,
  estimatedTokens: number,
  now = Date.now(),
): BudgetVerdict {
  const caps = getMonthlyBudgetCaps(keyId);
  if (caps.requestCap <= 0 && caps.tokenCap <= 0) return { allowed: true };

  const usage = getMonthlyUsage(keyId, now);
  for (const reservation of activeReservations()) {
    if (reservation.keyId !== keyId) continue;
    usage.requests++;
    usage.tokens += reservation.tokens;
  }
  if (caps.requestCap > 0 && usage.requests >= caps.requestCap) {
    return { allowed: false, reason: 'monthly_request_cap', retryAfterSec: secondsUntilNextMonth(now) };
  }
  if (caps.tokenCap > 0 && (usage.tokens >= caps.tokenCap || usage.tokens + Math.max(0, estimatedTokens) > caps.tokenCap)) {
    return { allowed: false, reason: 'monthly_token_cap', retryAfterSec: secondsUntilNextMonth(now) };
  }
  return { allowed: true };
}

/** Check and reserve before dispatch; release on every terminal path. */
export function reserveMonthlyBudget(
  keyId: number,
  estimatedTokens: number,
): { allowed: true; release: () => void } | Extract<BudgetVerdict, { allowed: false }> {
  const verdict = checkMonthlyBudget(keyId, estimatedTokens);
  if (!verdict.allowed) return verdict;
  const reservation = { keyId, tokens: Math.max(0, estimatedTokens) };
  activeReservations().add(reservation);
  return { allowed: true, release: () => { activeReservations().delete(reservation); } };
}

/** Seconds from `now` until the next UTC month boundary — the Retry-After value. */
export function secondsUntilNextMonth(now = Date.now()): number {
  return Math.max(1, Math.floor((utcNextMonthStartMs(now) - now) / 1000));
}

/** ISO timestamp of the next UTC month boundary (for headers / diagnostics). */
export function nextMonthResetAt(now = Date.now()): string {
  return new Date(utcNextMonthStartMs(now)).toISOString();
}
