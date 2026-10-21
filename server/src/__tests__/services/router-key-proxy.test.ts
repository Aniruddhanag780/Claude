import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest';
import { getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { encryptProxyUrl } from '../../lib/key-proxy.js';
import { routeRequest, setRoutingStrategy } from '../../services/router.js';
import { initTestDb } from '../helpers/test-db.js';

// Per-key proxy override (#590): the URL rides on the RouteResult the router
// already builds, so the dispatch loop needs neither a query nor a decrypt per
// attempt. These pin that contract — the loop reads route.proxyUrl and nothing
// else.
describe('Router — per-key proxy override (#590)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  beforeEach(async () => {
    const db = getDb();
    await setRoutingStrategy('priority');
    (await db.run('DELETE FROM api_keys'));
    (await db.run("DELETE FROM settings WHERE key = 'active_profile_id'"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function insertKey(proxyColumns: { encrypted: string | null; iv: string | null; authTag: string | null }): number {
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt('sk-google-1');
    const result = (await db.run(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, proxy_encrypted, proxy_iv, proxy_auth_tag)
      VALUES ('google', 'test', ?, ?, ?, 'healthy', 1, ?, ?, ?) RETURNING id`, [encrypted, iv, authTag, proxyColumns.encrypted, proxyColumns.iv, proxyColumns.authTag]));
    return Number(result.lastInsertRowid);
  }

  it('carries the decrypted proxy URL on the route', async () => {
    await insertKey(encryptProxyUrl('socks5h://alice:hunter2@proxy.internal:1080'));
    const route = await routeRequest();
    expect(route.platform).toBe('google');
    expect(route.proxyUrl).toBe('socks5h://alice:hunter2@proxy.internal:1080');
  });

  it("carries '' for a key with no override", async () => {
    await insertKey({ encrypted: null, iv: null, authTag: null });
    expect((await routeRequest()).proxyUrl).toBe('');
  });

  it('falls back to the global proxy when the override cannot be decrypted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Ciphertext from a different ENCRYPTION_KEY: the key itself still works,
    // so the request must proceed on the global proxy rather than fail.
    await insertKey({ encrypted: 'deadbeef', iv: '00'.repeat(16), authTag: '11'.repeat(16) });
    const route = await routeRequest();
    expect(route.apiKey).toBe('sk-google-1');
    expect(route.proxyUrl).toBe('');
    expect(warn).toHaveBeenCalled();
  });
});
