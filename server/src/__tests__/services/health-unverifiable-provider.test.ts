import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { initTestDb } from '../helpers/test-db.js';

// #1459: LLMTR refuses automated key checks and suspends accounts that keep
// sending them, so a provider with supportsKeyValidation === false must never
// be probed by the health pass or the cooldown probe.
const validateKey = vi.fn();
vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    resolveProvider: () => ({ name: 'no-probe', supportsKeyValidation: false, validateKey }),
  };
});

const { getDb } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { checkKeyHealth, checkAllKeys, probeKeyValidity, markKeyHealthyFromRequest } = await import('../../services/health.js');

describe('a provider that forbids key validation (#1459)', () => {
  let nextId = 9100;

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

  async function seedKey(status: string, lastError: string | null = null): number {
    const id = ++nextId;
    const enc = encrypt(`no-probe-${id}`);
    (await getDb().run(`
      INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, enabled, status, last_health_error)
      VALUES (?, 'llmtr', ?, ?, ?, ?, 1, ?, ?) RETURNING id`, [id, `no-probe-${id}`, enc.encrypted, enc.iv, enc.authTag, status, lastError]));
    return id;
  }

  async function row(id: number): { status: string; last_health_error: string | null } {
    return (await getDb().get('SELECT status, last_health_error FROM api_keys WHERE id = ?', [id])) as any;
  }

  it('checkKeyHealth sends no probe, keeps the status and clears the stored probe error', async () => {
    const id = await seedKey('unknown', 'LLMTR rejected the key-validation probe itself (automated validation not supported); the key was not checked');

    expect(await checkKeyHealth(id)).toBe('unknown');
    expect(validateKey).not.toHaveBeenCalled();
    expect(await row(id)).toEqual({ status: 'unknown', last_health_error: null });
  });

  it('a healthy key stays healthy through the scheduled pass with no probe sent', async () => {
    const id = await seedKey('healthy');

    await checkAllKeys({ force: true });

    expect(validateKey).not.toHaveBeenCalled();
    expect((await row(id)).status).toBe('healthy');
  });

  it('the cooldown probe treats the key as inconclusive without probing', async () => {
    const id = await seedKey('healthy');

    expect(await probeKeyValidity(id)).toBe('error');
    expect(validateKey).not.toHaveBeenCalled();
  });

  it('the first served request promotes the key to healthy', async () => {
    const id = await seedKey('unknown');

    markKeyHealthyFromRequest(id);

    expect(await row(id)).toEqual({ status: 'healthy', last_health_error: null });
  });
});
