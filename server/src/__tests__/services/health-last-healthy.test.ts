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
const {
  checkKeyHealth,
  markKeyHealthyFromRequest,
  clearLastHealthyStampState,
} = await import('../../services/health.js');

/**
 * #1493: a key can sit at status='healthy' with a fresh last_checked_at while
 * never actually working — the transport-error path refreshes last_checked_at
 * but proves nothing. last_healthy_at is the success-only timestamp: written on
 * a VALID probe verdict and on a served live request, never on a transport
 * error or an invalid verdict.
 */
describe('last_healthy_at (#1493)', () => {
  let nextId = 8200;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  beforeEach(() => {
    validateKey.mockReset();
    clearLastHealthyStampState();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  async function seedKey(status: string): number {
    const id = ++nextId;
    const enc = encrypt(`last-healthy-${id}`);
    (await getDb().run(`
      INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, enabled, status)
      VALUES (?, 'mistral', ?, ?, ?, ?, 1, ?) RETURNING id`, [id, `lh-${id}`, enc.encrypted, enc.iv, enc.authTag, status]));
    return id;
  }

  async function row(id: number): { last_healthy_at: string | null; last_checked_at: string | null; status: string } {
    return (await getDb().get('SELECT last_healthy_at, last_checked_at, status FROM api_keys WHERE id = ?', [id])) as any;
  }

  it('a valid probe stamps last_healthy_at', async () => {
    const id = await seedKey('unknown');
    validateKey.mockResolvedValue(true);

    expect(await checkKeyHealth(id)).toBe('healthy');
    expect((await row(id)).last_healthy_at).not.toBeNull();
  });

  it('an invalid verdict stamps last_checked_at but NOT last_healthy_at', async () => {
    const id = await seedKey('healthy');
    validateKey.mockResolvedValue(false);

    expect(await checkKeyHealth(id)).toBe('invalid');
    expect((await row(id)).last_checked_at).not.toBeNull();
    expect((await row(id)).last_healthy_at).toBeNull();
  });

  it('a transport error refreshes last_checked_at but NOT last_healthy_at', async () => {
    const id = await seedKey('healthy');
    validateKey.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.mistral.ai'));

    expect(await checkKeyHealth(id)).toBe('healthy');
    expect((await row(id)).last_checked_at).not.toBeNull();
    // This is exactly the #1493 gap: checked recently, never proven to work.
    expect((await row(id)).last_healthy_at).toBeNull();
  });

  it('a served request stamps last_healthy_at even on an already-healthy key', async () => {
    // The probe path never touched this key's last_healthy_at (transport-error
    // streak), and its status is healthy — the stamp must fire regardless of
    // current status, or the #1459 providers (no probes at all) never get one.
    const id = await seedKey('healthy');
    expect((await row(id)).last_healthy_at).toBeNull();

    markKeyHealthyFromRequest(id);

    expect((await row(id)).last_healthy_at).not.toBeNull();
    expect((await row(id)).status).toBe('healthy');
  });

  it('the traffic stamp is throttled in memory (no per-request DB write)', async () => {
    const id = await seedKey('error');

    // First call stamps; a second immediate call must skip the write. Prove it
    // by nulling the column in between: only a real second write would refill it.
    markKeyHealthyFromRequest(id);
    expect((await row(id)).last_healthy_at).not.toBeNull();
    (await getDb().run('UPDATE api_keys SET last_healthy_at = NULL WHERE id = ?', [id]));

    markKeyHealthyFromRequest(id);
    expect((await row(id)).last_healthy_at).toBeNull();

    // After clearing the throttle state, the next call stamps again.
    clearLastHealthyStampState();
    markKeyHealthyFromRequest(id);
    expect((await row(id)).last_healthy_at).not.toBeNull();
  });

  it('markKeyHealthyFromRequest still promotes error/unknown keys', async () => {
    const id = await seedKey('error');
    markKeyHealthyFromRequest(id);
    expect((await row(id)).status).toBe('healthy');
  });
});
