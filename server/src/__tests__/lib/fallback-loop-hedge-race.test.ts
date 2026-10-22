import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb } from '../../db/index.js';
import {
  runFallbackLoop, newFallbackState, getHedgeAfterMs, getStoredHedgeAfterMs, setHedgeAfterMs,
  HEDGE_AFTER_MS_MAX, type DispatchOutcome,
} from '../../lib/fallback-loop.js';
import { acquireLease, releaseLease, resetLeases } from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

/**
 * #1347 (PR 3): hedged racing — when the FIRST candidate is still silent
 * (no first byte) after hedgeAfterMs, the router's next pick starts IN
 * PARALLEL; the first to commit carries the response, the loser is aborted
 * and surfaces as 'hedge_lost' (no failure bookkeeping). Off by default.
 *
 * The fake dispatch below mirrors what the real surfaces do: a commit claim
 * (acquireCommit/onCommit) at the first byte, a 'hedge_lost' return when the
 * loop's per-attempt signal aborts a still-silent attempt, and plain resolve
 * / reject otherwise.
 */

let keySeq = 950;
function leasedRoute(modelId: string, keyId?: number): { route: RouteResult; keyId: number } {
  const id = keyId ?? ++keySeq;
  const lease = acquireLease('fake', modelId, id, 100);
  return {
    keyId: id,
    route: {
      provider: {} as any,
      modelId,
      modelDbId: 900000 + id,
      apiKey: `test-key-${id}`,
      keyId: id,
      platform: 'fake',
      displayName: `Fake ${modelId}`,
      rpdLimit: null,
      tpdLimit: null,
      release: () => releaseLease(lease),
    },
  };
}

type RaceCtl = {
  commit: () => void;
  done: () => void;
  fail: (err: any) => void;
  signal: AbortSignal | undefined;
  committed: () => boolean;
};

function makeSurfaceDispatch() {
  const ctls: RaceCtl[] = [];
  const dispatch = (_route: RouteResult, _attempt: number, ctx: any): Promise<DispatchOutcome> => {
    return new Promise<DispatchOutcome>((resolve, reject) => {
      let settled = false;
      let committed = false;
      const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
      const onAbort = () => {
        // Mirror of the real surface catch: aborted while still silent is a
        // hedge loss — 'canceled' row (logged by the real surface) +
        // 'hedge_lost', never a provider failure.
        if (!committed) finish(() => resolve('hedge_lost'));
      };
      if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });
      const ctl: RaceCtl = {
        commit: () => {
          if (committed) return;
          if (ctx.acquireCommit) {
            if (!ctx.acquireCommit()) { finish(() => resolve('hedge_lost')); return; }
            ctx.onCommit?.();
          }
          committed = true;
        },
        done: () => finish(() => resolve('done')),
        fail: (err: any) => finish(() => reject(err)),
        signal: ctx.signal,
        committed: () => committed,
      };
      ctls.push(ctl);
    });
  };
  return { dispatch, ctls };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function upsertErr(status: number, text: string): any {
  return Object.assign(new Error(text), { status });
}

describe('fallback loop hedged racing (#1347 PR 3)', () => {
  const savedHedgeEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    initDb(':memory:');
    resetLeases();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const name of Object.keys(process.env)) {
      if (name === 'ROUTER_HEDGE_AFTER_MS' || name.startsWith('HEDGE_AFTER_MS_')) {
        savedHedgeEnv[name] = process.env[name];
        delete process.env[name];
      }
    }
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedHedgeEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetLeases();
    vi.restoreAllMocks();
  });

  it('is OFF by default: a slow first candidate is simply waited for, no second dispatch', async () => {
    const state = newFallbackState();
    const a = leasedRoute('model-a');
    const { dispatch, ctls } = makeSurfaceDispatch();
    const route = vi.fn((attempt: number) => (attempt === 0 ? a.route : a.route));
    const logFailure = vi.fn();
    const onFatal = vi.fn();
    const onExhausted = vi.fn();

    const loopPromise = runFallbackLoop({
      state, timeBudgetMs: 0, route, dispatch, logFailure, onFatal, onExhausted,
      onRoutingExhausted: vi.fn(),
    } as any);

    await sleep(20); // A's dispatch registered its ctl
    // A stays slow well past the 50ms window where a race WOULD have fired if
    // hedging were on, then commits and finishes serially.
    await sleep(60);
    ctls[0].commit();
    ctls[0].done();
    await loopPromise;

    // Serial: only candidate A was ever dispatched; it committed and finished.
    expect(route).toHaveBeenCalledTimes(1);
    expect(ctls).toHaveLength(1);
    expect(ctls[0].committed()).toBe(true);
    expect(logFailure).not.toHaveBeenCalled();
    expect(onFatal).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('OFF: a failing first candidate fails over serially as before (no parallel sibling)', async () => {
    const state = newFallbackState();
    const a = leasedRoute('model-a');
    const b = leasedRoute('model-b');
    const { dispatch, ctls } = makeSurfaceDispatch();
    const route = vi.fn((attempt: number) => (attempt === 0 ? a.route : b.route));
    const logFailure = vi.fn();
    const onExhausted = vi.fn();

    // A fails 429; B (serial next hop) commits and finishes.
    const hooksPromise = (async () => {
      await runFallbackLoop({
        state, timeBudgetMs: 0, route, dispatch, logFailure, onFatal: vi.fn(), onExhausted,
        onRoutingExhausted: vi.fn(),
      } as any);
    })();
    await sleep(20); // let A's dispatch register its ctl
    ctls[0].fail(upsertErr(429, 'fake API error 429: rate limit'));
    await sleep(20); // serial next hop starts
    ctls[1].commit();
    ctls[1].done();
    await hooksPromise;

    expect(logFailure).toHaveBeenCalledTimes(1);
    expect(logFailure).toHaveBeenCalledWith(a.route, expect.anything(), 0);
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('ON: a silent first candidate loses the race — the sibling commits and carries the response', async () => {
    process.env.ROUTER_HEDGE_AFTER_MS = '50';
    const state = newFallbackState();
    const a = leasedRoute('model-a');
    const b = leasedRoute('model-b');
    const { dispatch, ctls } = makeSurfaceDispatch();
    const route = vi.fn((attempt: number) => (attempt === 0 ? a.route : b.route));
    const logFailure = vi.fn();
    const onFatal = vi.fn();
    const onExhausted = vi.fn();

    const loopPromise = runFallbackLoop({
      state, timeBudgetMs: 0, route, dispatch, logFailure, onFatal, onExhausted,
      onRoutingExhausted: vi.fn(),
    } as any);

    await sleep(80); // hedge timer (50ms) fires → B starts in parallel
    expect(ctls).toHaveLength(2);
    // B commits (claims the response) — A must be aborted as the loser.
    ctls[1].commit();
    expect(ctls[0].signal?.aborted).toBe(true);
    ctls[1].done();
    await loopPromise;

    // The loser produced no failure bookkeeping anywhere.
    expect(logFailure).not.toHaveBeenCalled();
    expect(onFatal).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
    // B's bookkeeping: the attempt index handed to its dispatch was 1.
    expect(route).toHaveBeenLastCalledWith(1);
  });

  it('ON: the first candidate can still win after the sibling started — the sibling is aborted', async () => {
    process.env.ROUTER_HEDGE_AFTER_MS = '50';
    const state = newFallbackState();
    const a = leasedRoute('model-a');
    const b = leasedRoute('model-b');
    const { dispatch, ctls } = makeSurfaceDispatch();
    const route = vi.fn((attempt: number) => (attempt === 0 ? a.route : b.route));
    const logFailure = vi.fn();
    const onFatal = vi.fn();
    const onExhausted = vi.fn();

    const loopPromise = runFallbackLoop({
      state, timeBudgetMs: 0, route, dispatch, logFailure, onFatal, onExhausted,
      onRoutingExhausted: vi.fn(),
    } as any);

    await sleep(80); // B starts in parallel
    expect(ctls).toHaveLength(2);
    // A commits later — it still wins; B (still silent) is aborted.
    ctls[0].commit();
    expect(ctls[1].signal?.aborted).toBe(true);
    expect(ctls[0].signal?.aborted).toBe(false);
    ctls[0].done();
    await loopPromise;

    expect(logFailure).not.toHaveBeenCalled();
    expect(onFatal).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('ON: both candidates fail without committing — both are bookkept, the ladder continues at attempt 2', async () => {
    process.env.ROUTER_HEDGE_AFTER_MS = '50';
    const state = newFallbackState();
    const a = leasedRoute('model-a');
    const b = leasedRoute('model-b');
    const attemptLog: any[] = [];
    const { dispatch, ctls } = makeSurfaceDispatch();
    const route = vi.fn((attempt: number) => (attempt === 0 ? a.route : b.route));
    const logFailure = vi.fn();
    const onFatal = vi.fn();
    const onExhausted = vi.fn();

    const loopPromise = runFallbackLoop({
      state, timeBudgetMs: 0, maxRetries: 2, attemptLog,
      route, dispatch, logFailure, onFatal, onExhausted,
      onRoutingExhausted: vi.fn(),
    } as any);

    await sleep(80); // B starts in parallel
    expect(ctls).toHaveLength(2);
    ctls[0].fail(upsertErr(429, 'fake API error 429: rate limit'));
    await sleep(30);
    ctls[1].fail(upsertErr(500, 'fake API error 500: internal error'));
    await loopPromise;

    // Both real upstream failures are recorded (A at attempt 0, B at 1).
    expect(logFailure).toHaveBeenCalledTimes(2);
    expect(logFailure).toHaveBeenCalledWith(a.route, expect.anything(), 0);
    expect(logFailure).toHaveBeenCalledWith(b.route, expect.anything(), 1);
    // Both keys are skipped for the rest of this request.
    expect(state.skipKeys.size).toBe(2);
    // The trail has one entry per failed attempt, in chronological order.
    expect(attemptLog).toHaveLength(2);
    expect(attemptLog[0].platform).toBe('fake');
    expect(attemptLog[1].platform).toBe('fake');
    // maxRetries=2: the race consumed attempts 0 AND 1 → honest exhaustion.
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('ON: route(1) returning the SAME candidate is not raced (no double-billing A against A)', async () => {
    process.env.ROUTER_HEDGE_AFTER_MS = '50';
    const state = newFallbackState();
    const a = leasedRoute('model-a');
    const { dispatch, ctls } = makeSurfaceDispatch();
    const route = vi.fn(() => a.route); // a pool of one
    const logFailure = vi.fn();
    const onFatal = vi.fn();
    const onExhausted = vi.fn();

    const loopPromise = runFallbackLoop({
      state, timeBudgetMs: 0, route, dispatch, logFailure, onFatal, onExhausted,
      onRoutingExhausted: vi.fn(),
    } as any);

    await sleep(80); // timer fired, but racing A against A is refused
    expect(ctls).toHaveLength(1);
    ctls[0].commit();
    ctls[0].done();
    await loopPromise;

    expect(route).toHaveBeenCalledTimes(2); // route(0) + route(1)
    expect(logFailure).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
  });
});

describe('getHedgeAfterMs resolution (#1347 PR 3)', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    initDb(':memory:');
    for (const name of Object.keys(process.env)) {
      if (name === 'ROUTER_HEDGE_AFTER_MS' || name.startsWith('HEDGE_AFTER_MS_')) {
        savedEnv[name] = process.env[name];
        delete process.env[name];
      }
    }
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('defaults to 0 (off) with no env and no setting', () => {
    expect(getHedgeAfterMs('groq')).toBe(0);
    expect(getStoredHedgeAfterMs()).toBeNull();
  });

  it('reads the dashboard setting', () => {
    setHedgeAfterMs(2500);
    expect(getHedgeAfterMs('groq')).toBe(2500);
    expect(getStoredHedgeAfterMs()).toBe(2500);
    setHedgeAfterMs(null);
    expect(getHedgeAfterMs('groq')).toBe(0);
    expect(getStoredHedgeAfterMs()).toBeNull();
  });

  it('the global env pin wins over the setting', () => {
    setHedgeAfterMs(2500);
    process.env.ROUTER_HEDGE_AFTER_MS = '100';
    expect(getHedgeAfterMs('groq')).toBe(100);
    // The stored dashboard value is reported as-is (the env pin is not
    // written back to the dashboard).
    expect(getStoredHedgeAfterMs()).toBe(2500);
  });

  it('a per-platform env pin wins over everything, including 0 (opt-out)', () => {
    setHedgeAfterMs(2500);
    process.env.ROUTER_HEDGE_AFTER_MS = '100';
    process.env.HEDGE_AFTER_MS_GROQ = '0';
    expect(getHedgeAfterMs('groq')).toBe(0);
    expect(getHedgeAfterMs('cerebras')).toBe(100);
    process.env.HEDGE_AFTER_MS_CEREBRAS = '777';
    expect(getHedgeAfterMs('cerebras')).toBe(777);
  });

  it('a malformed per-platform pin disables that platform, not the whole feature', () => {
    setHedgeAfterMs(2500);
    process.env.HEDGE_AFTER_MS_GROQ = 'not-a-number';
    expect(getHedgeAfterMs('groq')).toBe(0);
    expect(getHedgeAfterMs('cerebras')).toBe(2500);
  });

  it('rejects out-of-range values from the setter', () => {
    expect(() => setHedgeAfterMs(-1)).toThrow();
    expect(() => setHedgeAfterMs(HEDGE_AFTER_MS_MAX + 1)).toThrow();
    expect(() => setHedgeAfterMs(1.5)).toThrow();
  });
});
