import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { startCatalogSync, stopCatalogSync } from '../../services/catalog-sync.js';
import type { Scheduler } from '../../lib/scheduler.js';
import { initTestDb } from '../helpers/test-db.js';

function makeScheduler() {
  const every: { ms: number; fn: () => void | Promise<void> }[] = [];
  const after: { ms: number; fn: () => void | Promise<void> }[] = [];
  const cancels: ReturnType<typeof vi.fn>[] = [];
  const scheduler: Scheduler = {
    every(ms, fn) {
      const cancel = vi.fn();
      every.push({ ms, fn });
      cancels.push(cancel);
      return cancel;
    },
    after(ms, fn) {
      const cancel = vi.fn();
      after.push({ ms, fn });
      cancels.push(cancel);
      return cancel;
    },
  };
  return { scheduler, every, after, cancels };
}

describe('startCatalogSync / stopCatalogSync', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  afterEach(() => {
    stopCatalogSync();
    delete process.env.CATALOG_SYNC_DISABLED;
  });

  it('registers a 10-second boot delay and a 12-hour interval', async () => {
    const { scheduler, every, after } = makeScheduler();
    await startCatalogSync(scheduler);
    expect(after).toHaveLength(1);
    expect(after[0].ms).toBe(10 * 1000);
    expect(every).toHaveLength(1);
    expect(every[0].ms).toBe(12 * 60 * 60 * 1000);
  });

  it('is idempotent — double-start registers only one set of jobs', async () => {
    const { scheduler, every, after } = makeScheduler();
    await startCatalogSync(scheduler);
    await startCatalogSync(scheduler);
    expect(after).toHaveLength(1);
    expect(every).toHaveLength(1);
  });

  it('registers nothing when CATALOG_SYNC_DISABLED=1', async () => {
    process.env.CATALOG_SYNC_DISABLED = '1';
    const { scheduler, every, after } = makeScheduler();
    await startCatalogSync(scheduler);
    expect(after).toHaveLength(0);
    expect(every).toHaveLength(0);
  });

  it('stop invokes both cancel handles', async () => {
    const { scheduler, cancels } = makeScheduler();
    await startCatalogSync(scheduler);
    stopCatalogSync();
    expect(cancels).toHaveLength(2);
    cancels.forEach((c) => expect(c).toHaveBeenCalledOnce());
  });

  it('can re-register after stop', async () => {
    const { scheduler: s1 } = makeScheduler();
    await startCatalogSync(s1);
    stopCatalogSync();

    const { scheduler: s2, every, after } = makeScheduler();
    await startCatalogSync(s2);
    expect(after).toHaveLength(1);
    expect(every).toHaveLength(1);
  });
});
