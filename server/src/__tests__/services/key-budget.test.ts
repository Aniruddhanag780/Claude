import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { pruneRequestAnalytics } from '../../services/request-retention.js';
import { routePinnedModel, routeRequest } from '../../services/router.js';
import { routingExhaustionBody, setExhaustionHeaders } from '../../lib/fallback-loop.js';
import * as ledgerMigration from '../../db/migrations/20260914_000001_key_monthly_usage.js';
import { initTestDb } from '../helpers/test-db.js';
import {
  reserveMonthlyBudget,
  getMonthlyBudgetCaps,
  setMonthlyBudgetCaps,
  getMonthlyUsage,
  checkMonthlyBudget,
  secondsUntilNextMonth,
  nextMonthResetAt,
} from '../../services/key-budget.js';

// Per-key monthly budget (#1158): caps are opt-in (0 = unlimited), metering is
// the current UTC month's successful requests, and the rejection carries a
// Retry-After of seconds-until-next-month.

let keyId = 0;

async function insertKey(overrides: { status?: string; monthlyRequestCap?: number; monthlyTokenCap?: number } = {}) {
  const { encrypted, iv, authTag } = encrypt('sk-test');
  const result = (await getDb().run(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, monthly_request_cap, monthly_token_cap)
    VALUES ('groq', 'test', ?, ?, ?, ?, 1, ?, ?) RETURNING id`, [encrypted, iv, authTag, overrides.status ?? 'healthy', overrides.monthlyRequestCap ?? 0, overrides.monthlyTokenCap ?? 0]));
  keyId = Number(result.lastInsertRowid);
}

async function recordSuccess(now: Date) {
  (await getDb().run(`INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
     VALUES ('groq', 'llama', ?, 'success', 100, 50, 100, NULL, ?) RETURNING id`, [keyId, now.toISOString().slice(0, 19).replace('T', ' ')]));
}

async function recordFailure(now: Date) {
  (await getDb().run(`INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
     VALUES ('groq', 'llama', ?, 'error', 100, 0, 100, 'boom', ?) RETURNING id`, [keyId, now.toISOString().slice(0, 19).replace('T', ' ')]));
}

function inThisMonth(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 5, 12, 0, 0));
}

function lastMonth(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 20, 12, 0, 0));
}

describe('key-budget: monthly caps (#1158)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  beforeEach(async () => {
    (await getDb().run('DELETE FROM api_keys'));
    (await getDb().run('DELETE FROM requests'));
    keyId = 0;
  });

  it('defaults to unlimited (0 caps) for a fresh key', async () => {
    await insertKey();
    expect(await getMonthlyBudgetCaps(keyId)).toEqual({ requestCap: 0, tokenCap: 0 });
    expect(await checkMonthlyBudget(keyId, 100)).toEqual({ allowed: true });
  });

  it('setMonthlyBudgetCaps persists caps', async () => {
    await insertKey();
    expect(await setMonthlyBudgetCaps(keyId, { requestCap: 10, tokenCap: 5000 })).toBe(true);
    expect(await getMonthlyBudgetCaps(keyId)).toEqual({ requestCap: 10, tokenCap: 5000 });
    // Patching only one field leaves the other untouched.
    await setMonthlyBudgetCaps(keyId, { requestCap: 3 });
    expect(await getMonthlyBudgetCaps(keyId)).toEqual({ requestCap: 3, tokenCap: 5000 });
  });

  it('counts only the current month’s successful requests', async () => {
    await insertKey();
    await recordSuccess(inThisMonth()); // counts: 1 req, 150 tokens
    await recordSuccess(inThisMonth()); // counts: 2 req, 300 tokens
    await recordFailure(inThisMonth()); // excluded (status != success)
    await recordSuccess(lastMonth());   // excluded (previous month)

    const usage = await getMonthlyUsage(keyId);
    expect(usage.requests).toBe(2);
    expect(usage.tokens).toBe(300);
  });

  it('rejects at the request cap with a next-month Retry-After', async () => {
    await insertKey({ monthlyRequestCap: 2 });
    await recordSuccess(inThisMonth());
    await recordSuccess(inThisMonth());

    const verdict = await checkMonthlyBudget(keyId, 0);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toBe('monthly_request_cap');
      expect(verdict.retryAfterSec).toBeGreaterThan(0);
      // Retry-After should be at most ~32 days out (current month + 1 boundary).
      expect(verdict.retryAfterSec).toBeLessThanOrEqual(32 * 24 * 3600);
    }
  });

  it('rejects at the token cap, counting the estimated tokens of THIS request', async () => {
    await insertKey({ monthlyTokenCap: 1000 });
    await recordSuccess(inThisMonth()); // 150 tokens used

    // 150 + 900 > 1000 → rejected.
    expect((await checkMonthlyBudget(keyId, 900)).allowed).toBe(false);
    // 150 + 800 <= 1000 → allowed.
    expect(await checkMonthlyBudget(keyId, 800)).toEqual({ allowed: true });
  });

  it('blocks requests with no token estimate once the token cap is fully spent', async () => {
    await insertKey({ monthlyTokenCap: 150 });
    await recordSuccess(inThisMonth());
    expect(await checkMonthlyBudget(keyId, 0)).toMatchObject({ allowed: false, reason: 'monthly_token_cap' });
  });

  it('does not reject when the cap is hit exactly on the boundary request', async () => {
    await insertKey({ monthlyRequestCap: 2 });
    await recordSuccess(inThisMonth());
    await recordSuccess(inThisMonth());
    // usage.requests === cap → rejected (strictly at/over the cap counts spent).
    expect((await checkMonthlyBudget(keyId, 0)).allowed).toBe(false);
  });

  it('retains spent budgets when request logs are pruned', async () => {
    await insertKey({ monthlyRequestCap: 2 });
    await recordSuccess(inThisMonth()); await recordSuccess(inThisMonth());
    expect((await checkMonthlyBudget(keyId, 0)).allowed).toBe(false);
    const old = process.env.REQUEST_ANALYTICS_MAX_ROWS;
    try {
      process.env.REQUEST_ANALYTICS_MAX_ROWS = '1';
      await pruneRequestAnalytics({ force: true });
      expect((await getDb().get('SELECT COUNT(*) AS n FROM requests'))).toEqual({ n: 1 });
      expect(await getMonthlyUsage(keyId)).toEqual({ requests: 2, tokens: 300 });
      expect((await checkMonthlyBudget(keyId, 0)).allowed).toBe(false);
    } finally {
      if (old === undefined) delete process.env.REQUEST_ANALYTICS_MAX_ROWS;
      else process.env.REQUEST_ANALYTICS_MAX_ROWS = old;
    }
  });

  it('backfills the ledger once and does not double count when up is rerun', async () => {
    await insertKey();
    ledgerMigration.down(getDb());
    await recordSuccess(inThisMonth());
    ledgerMigration.up(getDb());
    ledgerMigration.up(getDb());
    expect(await getMonthlyUsage(keyId)).toEqual({ requests: 1, tokens: 150 });
    await recordSuccess(inThisMonth());
    expect(await getMonthlyUsage(keyId)).toEqual({ requests: 2, tokens: 300 });
  });

  it('reserves the last request slot and releases it after an unsuccessful attempt', async () => {
    await insertKey({ monthlyRequestCap: 1 });
    const first = await reserveMonthlyBudget(keyId, 100);
    expect(first.allowed).toBe(true);
    expect((await reserveMonthlyBudget(keyId, 100)).allowed).toBe(false);
    if (!first.allowed) throw new Error('expected a reservation');
    first.release(); first.release();
    expect((await checkMonthlyBudget(keyId, 100)).allowed).toBe(true);
    const second = await reserveMonthlyBudget(keyId, 100);
    if (!second.allowed) throw new Error('expected a reservation');
    await recordSuccess(inThisMonth());
    second.release();
    expect((await checkMonthlyBudget(keyId, 100)).allowed).toBe(false);
  });

  it('keeps token reservations for long streams until explicit release', async () => {
    await insertKey({ monthlyTokenCap: 1000 });
    const first = await reserveMonthlyBudget(keyId, 600);
    if (!first.allowed) throw new Error('expected a reservation');
    expect((await checkMonthlyBudget(keyId, 500, Date.now() + 10 * 60_000)).allowed).toBe(false);
    const second = await reserveMonthlyBudget(keyId, 400);
    expect(second.allowed).toBe(true);
    if (second.allowed) second.release();
    first.release();
    expect((await checkMonthlyBudget(keyId, 1000)).allowed).toBe(true);
  });

  it('resets completed usage at the next month while retaining active reservations', async () => {
    await insertKey({ monthlyRequestCap: 2 });
    await recordSuccess(inThisMonth());
    const first = await reserveMonthlyBudget(keyId, 100);
    if (!first.allowed) throw new Error('expected a reservation');
    expect((await checkMonthlyBudget(keyId, 0)).allowed).toBe(false);
    const nextMonth = Date.parse(nextMonthResetAt());
    expect((await getMonthlyUsage(keyId, nextMonth)).requests).toBe(0);
    expect((await checkMonthlyBudget(keyId, 0, nextMonth)).allowed).toBe(true);
    first.release();
  });

  it('enforces reservations through real route selection and exposes the monthly retry header', async () => {
    await insertKey({ monthlyRequestCap: 1 });
    const db = getDb();
    const model = (await db.get("SELECT id FROM models WHERE platform = 'groq' LIMIT 1")) as { id: number };
    (await db.run('UPDATE models SET enabled = 1, rpm_limit = NULL, rpd_limit = NULL, tpm_limit = NULL, tpd_limit = NULL WHERE id = ?', [model.id]));
    const first = await routePinnedModel(model.id, 100);
    expect(first).not.toBeNull();
    expect(await routePinnedModel(model.id, 100)).toBeNull();
    first?.release?.();
    const second = await routePinnedModel(model.id, 100);
    expect(second).not.toBeNull();
    second?.release?.();
    await recordSuccess(inThisMonth());
    let error: unknown;
    try { await routeRequest(100); } catch (err) { error = err; }
    expect(error).toBeDefined();
    const body = await routingExhaustionBody(error);
    expect(body.status).toBe(429);
    expect(body.code).toBe('quota_exceeded');
    expect(body.retryAtMs).toBe(Date.parse(nextMonthResetAt()));
    const headers: Record<string, string> = {};
    setExhaustionHeaders({ setHeader: (name: string, value: string) => { headers[name] = value; } }, body);
    expect(Number(headers['Retry-After'])).toBeGreaterThan(0);
  });

  it('secondsUntilNextMonth lands on the next UTC month boundary', () => {
    const now = Date.UTC(2026, 6, 15, 10, 0, 0); // 2026-07-15
    const secs = secondsUntilNextMonth(now);
    expect(secs).toBeGreaterThan(0);
    const reset = nextMonthResetAt(now);
    expect(reset).toBe('2026-08-01T00:00:00.000Z');
    // seconds until that boundary
    const expected = Math.floor((Date.parse('2026-08-01T00:00:00.000Z') - now) / 1000);
    expect(secs).toBe(expected);
  });
});
