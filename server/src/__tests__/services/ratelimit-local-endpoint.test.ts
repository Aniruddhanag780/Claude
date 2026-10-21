import { describe, it, expect, beforeAll } from 'vitest';

// #592 locality exemption: a key whose base_url points at loopback or an
// RFC1918/private address is a LOCAL inference server (Ollama / llama.cpp /
// LM Studio registered through the 'custom' platform). It has no provider
// quota, so neither the 90s transient bench nor the 2m→24h escalation ladder
// ever applies — the bench is capped at a few seconds, even for a literal 429
// (local servers emit those under concurrent load) and even when a Retry-After
// is attached. Non-local keys (public IPs/hostnames, built-in platforms with
// base_url NULL) keep the full pre-existing behavior.

import { getDb } from '../../db/index.js';
import { cooldownDecisionForError } from '../../lib/fallback-loop.js';
import type { RouteResult } from '../../services/router.js';
import { initTestDb } from '../helpers/test-db.js';

const MINUTE = 60_000;
const TRANSIENT = 90_000;
const LOCAL_CAP_MS = 5_000;

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  await initTestDb();
});

// Register a custom-platform key row carrying the endpoint, like
// routes/keys.ts POST /custom does, and return its real DB id.
async function insertKey(baseUrl: string | null): number {
  const r = (await getDb().run(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', 'test-endpoint', 'enc', 'iv', 'tag', 'valid', 1, ?) RETURNING id`, [baseUrl]));
  return Number(r.lastInsertRowid);
}

let modelSeq = 0;
function routeForKey(keyId: number): RouteResult {
  const n = ++modelSeq;
  return {
    provider: {} as any, modelId: `local-model-${n}`, modelDbId: 593_000 + n,
    apiKey: 'k', keyId, platform: 'custom', displayName: 'Local Model',
    rpdLimit: null, tpdLimit: null,
  };
}

const real429 = () => Object.assign(new Error('429 Too Many Requests'), { status: 429 });
const timeoutErr = () => Object.assign(new Error('Request timeout after 120000ms'), { name: 'TimeoutError' });

describe('local-endpoint cooldown cap (#592)', () => {
  it('loopback base_url: capped short bench even on repeated real 429s', async () => {
    const route = routeForKey(await insertKey('http://127.0.0.1:11434/v1'));
    for (let i = 0; i < 4; i++) {
      const decision = await cooldownDecisionForError(route, real429());
      expect(decision.durationMs).toBe(LOCAL_CAP_MS);
      expect(decision.source).toBe('heuristic');
    }
  });

  it('localhost hostname counts as loopback without DNS', async () => {
    const route = routeForKey(await insertKey('http://localhost:11434/v1'));
    expect((await cooldownDecisionForError(route, real429())).durationMs).toBe(LOCAL_CAP_MS);
    expect((await cooldownDecisionForError(route, timeoutErr())).durationMs).toBe(LOCAL_CAP_MS);
  });

  it('RFC1918 base_url (LAN box): capped the same way', async () => {
    for (const url of ['http://192.168.1.50:8080/v1', 'http://10.0.0.7:11434/v1', 'http://172.16.4.2:5000/v1']) {
      const route = routeForKey(await insertKey(url));
      expect((await cooldownDecisionForError(route, real429())).durationMs).toBe(LOCAL_CAP_MS);
      expect((await cooldownDecisionForError(route, real429())).durationMs).toBe(LOCAL_CAP_MS);
    }
  });

  it('ignores an upstream Retry-After on a local endpoint', async () => {
    const route = routeForKey(await insertKey('http://127.0.0.1:8080/v1'));
    const err = Object.assign(new Error('429 Too Many Requests'), { status: 429, retryAfterMs: 5 * MINUTE });
    expect((await cooldownDecisionForError(route, err)).durationMs).toBe(LOCAL_CAP_MS);
  });

  it('public-IP base_url is NOT exempt: transient then ladder on real 429s', async () => {
    const route = routeForKey(await insertKey('http://203.0.113.10/v1'));
    expect((await cooldownDecisionForError(route, real429())).durationMs).toBe(TRANSIENT);
    expect((await cooldownDecisionForError(route, real429())).durationMs).toBe(2 * MINUTE);
    expect((await cooldownDecisionForError(route, real429())).durationMs).toBe(10 * MINUTE);
  });

  it('non-literal hostname is treated as non-local (no DNS on the hot path)', async () => {
    const route = routeForKey(await insertKey('https://inference.example.com/v1'));
    expect((await cooldownDecisionForError(route, real429())).durationMs).toBe(TRANSIENT);
    expect((await cooldownDecisionForError(route, real429())).durationMs).toBe(2 * MINUTE);
  });

  it('a key with no base_url (built-in platform shape) keeps full behavior', async () => {
    const route = routeForKey(await insertKey(null));
    expect((await cooldownDecisionForError(route, real429())).durationMs).toBe(TRANSIENT);
    expect((await cooldownDecisionForError(route, real429())).durationMs).toBe(2 * MINUTE);
  });
});
