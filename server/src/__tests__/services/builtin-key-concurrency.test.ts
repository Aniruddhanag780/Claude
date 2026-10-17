import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  getKeyConcurrencyLimit, canUseKeyConcurrency, acquireLease, releaseLease, resetLeases,
} from '../../services/ratelimit.js';
import {
  BUILTIN_KEY_CONCURRENCY,
  BUILTIN_KEY_CONCURRENCY_SETTING,
  isBuiltinKeyConcurrencyEnabled,
  setBuiltinKeyConcurrency,
} from '../../lib/platform-concurrency.js';

// #1347 (PR 2): built-in per-key concurrency defaults, opt-in. With the
// feature OFF (the default) getKeyConcurrencyLimit must behave exactly as
// today (env vars only, otherwise unlimited); with it ON, listed platforms
// fall back to their conservative built-in cap, env vars still win.

const ENV_PIN = 'ROUTER_BUILTIN_KEY_CONCURRENCY';
const ENV_GROQ = 'MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ';
const ENV_ALL = 'MAX_CONCURRENT_REQUESTS_PER_KEY';

const SAVED: Record<string, string | undefined> = {};

function clearConcurrencyEnv(): void {
  for (const name of [ENV_PIN, ENV_GROQ, ENV_ALL]) {
    SAVED[name] = process.env[name];
    delete process.env[name];
  }
}

describe('built-in per-key concurrency defaults (#1347 PR 2)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    clearConcurrencyEnv();
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(BUILTIN_KEY_CONCURRENCY_SETTING);
    resetLeases();
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(SAVED)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetLeases();
  });

  it('is OFF by default — env-only behaviour, unlimited like today', () => {
    expect(isBuiltinKeyConcurrencyEnabled()).toBe(false);
    expect(getKeyConcurrencyLimit('groq')).toBeNull();
    expect(getKeyConcurrencyLimit('groq')).toBe(BUILTIN_KEY_CONCURRENCY.groq === undefined ? null : null);
  });

  it('ON: listed platforms fall back to their built-in cap', () => {
    setBuiltinKeyConcurrency(true);
    expect(isBuiltinKeyConcurrencyEnabled()).toBe(true);
    expect(getKeyConcurrencyLimit('groq')).toBe(BUILTIN_KEY_CONCURRENCY.groq);
    expect(getKeyConcurrencyLimit('cerebras')).toBe(BUILTIN_KEY_CONCURRENCY.cerebras);
  });

  it('ON: unlisted platforms stay uncapped (wrong default is worse than none)', () => {
    setBuiltinKeyConcurrency(true);
    // 'sail' and 'inferbase' are real platforms absent from the table.
    expect(getKeyConcurrencyLimit('sail')).toBeNull();
    expect(getKeyConcurrencyLimit('inferbase')).toBeNull();
  });

  it('ON: a per-platform env cap still wins over the built-in', () => {
    setBuiltinKeyConcurrency(true);
    process.env[ENV_GROQ] = '2';
    expect(getKeyConcurrencyLimit('groq')).toBe(2);
    // The global env cap applies to unlisted platforms too.
    process.env[ENV_ALL] = '7';
    expect(getKeyConcurrencyLimit('sail')).toBe(7);
  });

  it('ON: a malformed env cap falls through to the built-in (not null)', () => {
    setBuiltinKeyConcurrency(true);
    process.env[ENV_GROQ] = 'not-a-number';
    expect(getKeyConcurrencyLimit('groq')).toBe(BUILTIN_KEY_CONCURRENCY.groq);
  });

  it('the env pin forces OFF over the stored setting', () => {
    setBuiltinKeyConcurrency(true);
    process.env[ENV_PIN] = '0';
    expect(isBuiltinKeyConcurrencyEnabled()).toBe(false);
    expect(getKeyConcurrencyLimit('groq')).toBeNull();
  });

  it('the env pin forces ON over an unset setting', () => {
    process.env[ENV_PIN] = '1';
    expect(isBuiltinKeyConcurrencyEnabled()).toBe(true);
    expect(getKeyConcurrencyLimit('groq')).toBe(BUILTIN_KEY_CONCURRENCY.groq);
  });

  it('ON: canUseKeyConcurrency blocks a key at its built-in cap and frees it on release', () => {
    setBuiltinKeyConcurrency(true);
    const cap = BUILTIN_KEY_CONCURRENCY.groq;
    const leaseIds: number[] = [];
    for (let i = 0; i < cap; i++) leaseIds.push(acquireLease('groq', 'llama-3.3-70b', 1, 100));
    expect(canUseKeyConcurrency('groq', 1)).toBe(false);
    // A sibling key on the same platform is unaffected — the cap is per key.
    expect(canUseKeyConcurrency('groq', 2)).toBe(true);
    releaseLease(leaseIds[0]);
    expect(canUseKeyConcurrency('groq', 1)).toBe(true);
    for (const id of leaseIds) releaseLease(id);
  });

  it('OFF: no cap applies even past the built-in value', () => {
    const cap = BUILTIN_KEY_CONCURRENCY.groq;
    for (let i = 0; i < cap + 5; i++) acquireLease('groq', 'llama-3.3-70b', 1, 100);
    expect(canUseKeyConcurrency('groq', 1)).toBe(true);
  });
});
