import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { initTestDb } from '../helpers/test-db.js';

const validateKey = vi.fn();
vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    resolveProvider: () => ({ name: 'fake', validateKey }),
  };
});

const { getDb } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { checkKeyHealth, checkAllKeys, markKeyHealthyFromRequest } = await import('../../services/health.js');

/**
 * selectKeyForModel only accepts keys with status IN ('healthy','unknown'), so
 * writing status='error' removes a key's capacity entirely. A transport error
 * (DNS, TLS, timeout, suspended laptop) says nothing about the credential, so it
 * must not demote — otherwise one blip benches every key on a provider at once.
 */
describe('transport errors do not demote a key', () => {
  let nextId = 7000;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  beforeEach(() => {
    validateKey.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  async function seedKey(status: string): number {
    const id = ++nextId;
    const enc = encrypt(`health-preserve-${id}`);
    (await getDb().run(`
      INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, enabled, status)
      VALUES (?, 'mistral', ?, ?, ?, ?, 1, ?) RETURNING id`, [id, `preserve-${id}`, enc.encrypted, enc.iv, enc.authTag, status]));
    return id;
  }

  async function statusOf(id: number): string {
    return ((await getDb().get('SELECT status FROM api_keys WHERE id = ?', [id])) as { status: string }).status;
  }

  it('keeps a healthy key healthy through a transport failure', async () => {
    const id = await seedKey('healthy');
    validateKey.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.mistral.ai'));

    expect(await checkKeyHealth(id)).toBe('healthy');
    expect(await statusOf(id)).toBe('healthy');
  });

  it('records the diagnostic and timestamp even though status is unchanged', async () => {
    const id = await seedKey('healthy');
    validateKey.mockRejectedValue(new Error('socket hang up'));

    await checkKeyHealth(id);
    const row = (await getDb().get('SELECT last_health_error, last_checked_at FROM api_keys WHERE id = ?', [id])) as { last_health_error: string; last_checked_at: string | null };

    expect(row.last_health_error).toContain('socket hang up');
    expect(row.last_checked_at).not.toBeNull();
  });

  it('still demotes on a confirmed bad credential', async () => {
    const id = await seedKey('healthy');
    validateKey.mockResolvedValue({ valid: false, error: 'HTTP 401 invalid key' });

    expect(await checkKeyHealth(id)).toBe('invalid');
    expect(await statusOf(id)).toBe('invalid');
  });

  it('an offline burst leaves every key routable', async () => {
    const ids = [await seedKey('healthy'), await seedKey('healthy'), await seedKey('unknown')];
    validateKey.mockRejectedValue(new Error('fetch failed'));

    await checkAllKeys();

    // Previously all three would have gone to 'error' and the router would have
    // had zero usable keys until a later pass succeeded.
    expect(ids.map(statusOf)).toEqual(['healthy', 'healthy', 'unknown']);
  });
});

describe('markKeyHealthyFromRequest', () => {
  let nextId = 8000;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  async function seedKey(status: string): number {
    const id = ++nextId;
    const enc = encrypt(`heal-${id}`);
    (await getDb().run(`
      INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, enabled, status, last_health_error)
      VALUES (?, 'groq', ?, ?, ?, ?, 1, ?, 'stale reason') RETURNING id`, [id, `heal-${id}`, enc.encrypted, enc.iv, enc.authTag, status]));
    return id;
  }

  async function row(id: number): { status: string; last_health_error: string | null } {
    return (await getDb().get('SELECT status, last_health_error FROM api_keys WHERE id = ?', [id])) as any;
  }

  it("promotes an 'error' key back to healthy and clears the stale reason", async () => {
    const id = await seedKey('error');
    markKeyHealthyFromRequest(id);
    expect(await row(id)).toEqual({ status: 'healthy', last_health_error: null });
  });

  it("promotes a never-probed 'unknown' key to healthy (#1459)", async () => {
    const id = await seedKey('unknown');
    markKeyHealthyFromRequest(id);
    expect(await row(id)).toEqual({ status: 'healthy', last_health_error: null });
  });

  it("never resurrects an 'invalid' key — only a real probe clears that", async () => {
    const id = await seedKey('invalid');
    markKeyHealthyFromRequest(id);
    expect((await row(id)).status).toBe('invalid');
  });

  it('leaves an already-healthy key untouched', async () => {
    const id = await seedKey('healthy');
    markKeyHealthyFromRequest(id);
    expect((await row(id)).status).toBe('healthy');
  });

  it('is silent for an unknown key id', () => {
    expect(() => markKeyHealthyFromRequest(999_999)).not.toThrow();
  });
});
