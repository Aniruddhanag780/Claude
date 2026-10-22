import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { clearAllCooldowns, isOnCooldown } from '../../services/ratelimit.js';
import {
  runDecision,
  DecisionError,
  listDecisionModels,
  setDecisionModelEnabled,
  decisionsAvailable,
  DECISION_PLATFORMS,
} from '../../services/decision.js';
import { listAllMediaModels } from '../../services/media.js';
import { seedDecisionModels } from '../helpers/decision-models.js';
import { initTestDb } from '../helpers/test-db.js';

const realFetch = globalThis.fetch;

async function addKey(platform: string, raw = `${platform}-test-key`): number {
  const { encrypted, iv, authTag } = encrypt(raw);
  const row = (await getDb().run(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1) RETURNING id`, [platform, encrypted, iv, authTag]));
  return Number(row.lastInsertRowid);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

type Call = [string, RequestInit];
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn((url: string, init: RequestInit) => Promise.resolve(handler(String(url), init)));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}
const calls = (fn: ReturnType<typeof mockFetch>) => fn.mock.calls as unknown as Call[];
const bodyOf = (call: Call) => JSON.parse(call[1].body as string);

const REQUEST = {
  state: 'Write a Python function that merges two sorted lists.',
  questions: {
    tier: { type: 'choice' as const, instructions: 'Which tier should answer?', criteria: { light: 'chat', code: 'coding' } },
  },
};
const ANSWERS = { tier: { type: 'choice', choice: 'code', probabilities: { light: 0.02, code: 0.98 }, confidence: 0.96 } };

async function logRows() {
  return (await getDb().all('SELECT model_id, platform, status, question_count, input_tokens FROM decision_requests ORDER BY id')) as
    Array<{ model_id: string; platform: string; status: string; question_count: number; input_tokens: number }>;
}

describe('decision service', () => {
  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
    await seedDecisionModels();
    await clearAllCooldowns(Number.MAX_SAFE_INTEGER);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('has adapters for the supported decision platforms', () => {
    expect([...DECISION_PLATFORMS].sort()).toEqual(['apinex', 'beatapi', 'cloudflare', 'openrouter']);
  });

  it('calls Cloudflare ai/run with the account from the key and the short model selector', async () => {
    await addKey('cloudflare', 'acct123:cf-token');
    const fn = mockFetch(() => json({ success: true, result: { model: 'clef-flash', answers: ANSWERS, usage: { input_tokens: 219, output_tokens: 0 } } }));
    const out = await runDecision(REQUEST, { clientAgent: null });
    expect(out).toEqual({ model: '@cf/cloudflare/clef-flash', provider: 'cloudflare', answers: ANSWERS, usage: { input_tokens: 219, output_tokens: 0 } });
    const [url, init] = calls(fn)[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/cloudflare/clef-flash');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer cf-token');
    expect(bodyOf(calls(fn)[0])).toEqual({ model: 'clef-flash', state: REQUEST.state, questions: REQUEST.questions });
    expect(await logRows()).toEqual([{ model_id: '@cf/cloudflare/clef-flash', platform: 'cloudflare', status: 'ok', question_count: 1, input_tokens: 219 }]);
  });

  it('calls OpenRouter alpha decisions with the full model id', async () => {
    await addKey('openrouter', 'sk-or-test');
    const fn = mockFetch(() => json({ model: 'inception/mercury-decide-20260930', answers: ANSWERS, usage: { input_tokens: 156, output_tokens: 1, cost: 0 } }));
    const out = await runDecision(REQUEST, { model: 'inception/mercury-decide:free', clientAgent: null });
    expect(out.provider).toBe('openrouter');
    expect(out.answers).toEqual(ANSWERS);
    expect(calls(fn)[0][0]).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(bodyOf(calls(fn)[0]).model).toBe('inception/mercury-decide:free');
  });

  it("'auto' falls over to the next model when the first one's key is rate limited", async () => {
    const cfKey = await addKey('cloudflare', 'acct:tok');
    await addKey('openrouter', 'sk-or');
    const fn = mockFetch(url => url.includes('cloudflare')
      ? json({ errors: [{ message: 'rate limited' }] }, 429, { 'retry-after': '30' })
      : json({ answers: ANSWERS, usage: { input_tokens: 150, output_tokens: 1 } }));
    const out = await runDecision(REQUEST, { model: 'auto', clientAgent: null });
    expect(out.provider).toBe('openrouter');
    expect(calls(fn)).toHaveLength(2);
    expect(await isOnCooldown('cloudflare', '@cf/cloudflare/clef-flash', cfKey)).toBe(true);
    expect(await logRows().map(r => r.status)).toEqual(['error', 'ok']);
  });

  it('honours a back-off stated in the error body when there is no header', async () => {
    await addKey('cloudflare', 'acct:tok');
    // A Gemini-shaped RetryInfo in the body with no Retry-After header: the
    // chat path (buildUpstreamError) already reads it; the decision chain must too.
    mockFetch(() => json({ error: { message: 'busy', retry_delay: '45s' } }, 429));
    const err = await runDecision(REQUEST, { model: '@cf/cloudflare/clef-flash', clientAgent: null }).catch(e => e);
    expect(err).toBeInstanceOf(DecisionError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(45_000);
  });

  it('prefers a header Retry-After over a body hint', async () => {
    await addKey('cloudflare', 'acct:tok');
    mockFetch(() => json({ error: { message: 'busy', retry_delay: '45s' } }, 429, { 'retry-after': '12' }));
    const err = await runDecision(REQUEST, { model: '@cf/cloudflare/clef-flash', clientAgent: null }).catch(e => e);
    expect(err.retryAfterMs).toBe(12_000);
  });

  it('skips models whose platform has no key', async () => {
    await addKey('openrouter');
    const fn = mockFetch(() => json({ answers: ANSWERS, usage: {} }));
    const out = await runDecision(REQUEST, { clientAgent: null });
    expect(out.provider).toBe('openrouter');
    expect(calls(fn)).toHaveLength(1);
  });

  it('says how to fix it when no platform key exists', async () => {
    await expect(runDecision(REQUEST, { clientAgent: null })).rejects.toMatchObject({ status: 503, code: 'no_decision_keys' });
    expect(await decisionsAvailable()).toBe(false);
  });

  it('rejects an unknown or turned-off model with a 400', async () => {
    await addKey('openrouter');
    await expect(runDecision(REQUEST, { model: 'nope', clientAgent: null })).rejects.toMatchObject({ status: 400 });
    const id = (await listDecisionModels()).find(m => m.platform === 'openrouter')!.id;
    expect(await setDecisionModelEnabled(id, false)).toBe(true);
    await expect(runDecision(REQUEST, { model: 'inception/mercury-decide:free', clientAgent: null })).rejects.toThrow(/turned off/);
  });

  it('does not pass an upstream 401 through as the caller\'s fault', async () => {
    await addKey('cloudflare', 'acct:bad');
    mockFetch(() => json({ errors: [{ message: 'bad token' }] }, 401));
    const err = await runDecision(REQUEST, { model: '@cf/cloudflare/clef-flash', clientAgent: null }).catch(e => e);
    expect(err).toBeInstanceOf(DecisionError);
    expect(err.status).toBe(502);
  });

  it('treats a Cloudflare success:false body as a failure', async () => {
    await addKey('cloudflare', 'acct:tok');
    mockFetch(() => json({ success: false, errors: [{ message: 'model error' }] }));
    await expect(runDecision(REQUEST, { model: '@cf/cloudflare/clef-flash', clientAgent: null })).rejects.toMatchObject({ status: 502 });
  });

  it('lists models with key counts and monthly usage', async () => {
    await addKey('cloudflare', 'acct:tok');
    mockFetch(() => json({ success: true, result: { answers: ANSWERS, usage: { input_tokens: 10 } } }));
    await runDecision(REQUEST, { clientAgent: null });
    const [cf, or] = await listDecisionModels();
    expect(cf).toMatchObject({ modelId: '@cf/cloudflare/clef-flash', enabled: true, keyCount: 1, healthyKeyCount: 1, decisionsThisMonth: 1, contextWindow: 24576 });
    expect(or).toMatchObject({ modelId: 'inception/mercury-decide:free', keyCount: 0, decisionsThisMonth: 0 });
  });

  it('keeps decision models off the image/audio media list', async () => {
    expect((await listAllMediaModels()).some(m => m.modality === 'decision')).toBe(false);
  });

  it('only toggles decision rows', async () => {
    (await getDb().run(`INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label)
                     VALUES ('cloudflare', 'img', 'Img', 'image', 0, 1, '') RETURNING id`));
    const imageId = ((await getDb().get("SELECT id FROM media_models WHERE model_id = 'img'")) as { id: number }).id;
    expect(await setDecisionModelEnabled(imageId, false)).toBe(false);
  });
});
