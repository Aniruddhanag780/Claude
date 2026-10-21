import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from '../../db/index.js';
import { parseProviderLimit, learnLimitFromError } from '../../services/ratelimit.js';
import { initTestDb } from '../helpers/test-db.js';

describe('parseProviderLimit', () => {
  it('parses a Groq 413 TPM body', () => {
    const msg = 'Groq API error 413: Request too large for model `llama-4-scout` in organization org_x service tier `on_demand` on tokens per minute (TPM): Limit 30000, Requested 33476. Please try again later.';
    expect(parseProviderLimit(msg)).toEqual({ kind: 'tpm', limit: 30000 });
  });

  it('parses RPM / RPD / TPD axes', () => {
    expect(parseProviderLimit('on requests per minute (RPM): Limit 30, Requested 31')).toEqual({ kind: 'rpm', limit: 30 });
    expect(parseProviderLimit('on requests per day (RPD): Limit 1000, Used 1000')).toEqual({ kind: 'rpd', limit: 1000 });
    expect(parseProviderLimit('on tokens per day (TPD): Limit 500000')).toEqual({ kind: 'tpd', limit: 500000 });
  });

  it('strips thousands separators in the limit', () => {
    expect(parseProviderLimit('tokens per minute (TPM): Limit 1,000,000, Requested 2,000,000')).toEqual({ kind: 'tpm', limit: 1_000_000 });
  });

  it('prefers the token axis when both tokens and requests are mentioned', () => {
    expect(parseProviderLimit('requests per minute and tokens per minute (TPM): Limit 8000')).toEqual({ kind: 'tpm', limit: 8000 });
  });

  it('returns null without a confident axis even when a Limit is present', () => {
    expect(parseProviderLimit('Some limit: 9999 was exceeded')).toBeNull();
  });

  it('returns null when there is no numeric limit', () => {
    expect(parseProviderLimit('tokens per minute (TPM) exceeded, slow down')).toBeNull();
  });

  it('returns null for empty / non-limit errors', () => {
    expect(parseProviderLimit('')).toBeNull();
    expect(parseProviderLimit(undefined)).toBeNull();
    expect(parseProviderLimit('API error 500: internal server error')).toBeNull();
  });
});

describe('learnLimitFromError (persistence)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  async function insertModel(fields: { tpm?: number | null; rpm?: number | null } = {}): number {
    const info = (await getDb().run(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, tpm_limit, rpm_limit)
       VALUES ('groq', ?, 'M', 50, 50, ?, ?) RETURNING id`, [`m-${Math.random().toString(36).slice(2)}`, fields.tpm ?? null, fields.rpm ?? null]));
    return info.lastInsertRowid as number;
  }
  const tpmCol = async (id: number) => ((await getDb().get('SELECT tpm_limit FROM models WHERE id = ?', [id])) as { tpm_limit: number | null }).tpm_limit;

  it('fills a NULL limit from a learned ceiling', async () => {
    const id = await insertModel({ tpm: null });
    const r = await learnLimitFromError(id, { message: 'tokens per minute (TPM): Limit 6000, Requested 9000' });
    expect(r).toEqual({ kind: 'tpm', limit: 6000 });
    expect(await tpmCol(id)).toBe(6000);
  });

  it('lowers an existing limit that was too high', async () => {
    const id = await insertModel({ tpm: 40000 });
    const r = await learnLimitFromError(id, { message: 'tokens per minute (TPM): Limit 30000, Requested 33000' });
    expect(r).toEqual({ kind: 'tpm', limit: 30000 });
    expect(await tpmCol(id)).toBe(30000);
  });

  it('never RAISES an already-lower limit', async () => {
    const id = await insertModel({ tpm: 6000 });
    const r = await learnLimitFromError(id, { message: 'tokens per minute (TPM): Limit 30000, Requested 33000' });
    expect(r).toBeNull();
    expect(await tpmCol(id)).toBe(6000);
  });

  it('is a no-op for an error with no parseable limit', async () => {
    const id = await insertModel({ tpm: 12345 });
    const r = await learnLimitFromError(id, { message: 'API error 500: internal server error' });
    expect(r).toBeNull();
    expect(await tpmCol(id)).toBe(12345);
  });

  it('writes to the correct column per axis (RPM)', async () => {
    const id = await insertModel({ rpm: null });
    await learnLimitFromError(id, { message: 'requests per minute (RPM): Limit 20, Requested 21' });
    const rpm = ((await getDb().get('SELECT rpm_limit FROM models WHERE id = ?', [id])) as { rpm_limit: number | null }).rpm_limit;
    expect(rpm).toBe(20);
  });
});
