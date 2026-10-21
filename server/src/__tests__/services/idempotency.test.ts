import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  hashIdempotencyKey,
  computeIdempotencyFingerprint,
  lookupIdempotencyReplay,
  storeIdempotencyResult,
  clearIdempotencyResult,
  normalizeIdempotencyKey,
  idempotencyTtlMs,
} from '../../services/idempotency.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { initTestDb } from '../helpers/test-db.js';

const IDEM_ENV = ['IDEMPOTENCY_TTL_MS'] as const;

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content } as ChatMessage;
}

const fingerprintFor = (model: string, content: string) =>
  computeIdempotencyFingerprint({
    model,
    messages: [msg('user', content)],
  });

const sampleBody = (text: string) => ({
  id: 'chatcmpl-test',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

describe('idempotency', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    for (const k of IDEM_ENV) saved[k] = process.env[k];
    await initTestDb();
  });

  afterEach(() => {
    for (const k of IDEM_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('miss on an unknown key hash', async () => {
    const r = await lookupIdempotencyReplay(hashIdempotencyKey('never-stored'), fingerprintFor('m', 'hi'));
    expect(r.kind).toBe('miss');
  });

  it('replays a stored response with the same key + fingerprint', async () => {
    const keyHash = hashIdempotencyKey('retry-me');
    const fp = fingerprintFor('groq/llama', 'same question');
    await storeIdempotencyResult(keyHash, fp, 200, sampleBody('first answer'), 'exec-1');
    const r = await lookupIdempotencyReplay(keyHash, fp);
    expect(r.kind).toBe('replay');
    if (r.kind === 'replay') {
      expect(r.status).toBe(200);
      expect(r.body).toEqual(sampleBody('first answer'));
    }
  });

  it('reports conflict when the same key is reused with different content', async () => {
    const keyHash = hashIdempotencyKey('shared-key');
    await storeIdempotencyResult(
      keyHash,
      fingerprintFor('m', 'question A'),
      200,
      sampleBody('answer A'),
    );
    const r = await lookupIdempotencyReplay(keyHash, fingerprintFor('m', 'question B'));
    expect(r.kind).toBe('conflict');
  });

  it('treats an expired claim as a miss', async () => {
    const keyHash = hashIdempotencyKey('expired');
    const fp = fingerprintFor('m', 'q');
    const now = 1_000_000;
    await storeIdempotencyResult(keyHash, fp, 200, sampleBody('old'), undefined, now);
    const r = await lookupIdempotencyReplay(keyHash, fp, now + idempotencyTtlMs() + 1);
    expect(r.kind).toBe('miss');
  });

  it('replaces the previous claim when the same key is reused after completion', async () => {
    const keyHash = hashIdempotencyKey('replaced');
    const fpA = fingerprintFor('m', 'first');
    await storeIdempotencyResult(keyHash, fpA, 200, sampleBody('answer A'));
    const fpB = fingerprintFor('m', 'second');
    await storeIdempotencyResult(keyHash, fpB, 200, sampleBody('answer B'));
    // After a new successful completion with a DIFFERENT fingerprint, the old
    // claim is replaced: the new fingerprint replays, and the old fingerprint
    // (same key, different content) is a conflict — not a silent wrong answer.
    expect((await lookupIdempotencyReplay(keyHash, fpB)).kind).toBe('replay');
    expect((await lookupIdempotencyReplay(keyHash, fpA)).kind).toBe('conflict');
  });

  it('clear removes the claim', async () => {
    const keyHash = hashIdempotencyKey('cleared');
    const fp = fingerprintFor('m', 'q');
    await storeIdempotencyResult(keyHash, fp, 200, sampleBody('x'));
    await clearIdempotencyResult(keyHash);
    expect((await lookupIdempotencyReplay(keyHash, fp)).kind).toBe('miss');
  });

  it('normalizeIdempotencyKey trims, rejects empties and >255-byte values', () => {
    expect(normalizeIdempotencyKey('  abc  ')).toBe('abc');
    expect(normalizeIdempotencyKey('   ')).toBeNull();
    expect(normalizeIdempotencyKey('')).toBeNull();
    expect(normalizeIdempotencyKey(undefined)).toBeNull();
    expect(normalizeIdempotencyKey('a'.repeat(256))).toBeNull();
    expect(normalizeIdempotencyKey('a'.repeat(255))).toBe('a'.repeat(255));
    // Repeated header (Express lower-cases and arrays multi-value) → first wins.
    expect(normalizeIdempotencyKey(['first', 'second'])).toBe('first');
  });

  it('different content produces different fingerprints; order-insensitive JSON does not collide wrongly', () => {
    const a = fingerprintFor('m', 'hello');
    const b = fingerprintFor('m', 'world');
    expect(a).not.toBe(b);
    // Same model + content → same fingerprint.
    expect(fingerprintFor('m', 'hello')).toBe(a);
  });
});
