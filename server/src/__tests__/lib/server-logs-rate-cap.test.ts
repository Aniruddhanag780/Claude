import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../db/index.js';
import { initTestDb } from '../helpers/test-db.js';
import {
  PERSIST_MAX_PER_SECOND,
  initServerLogs,
  recordLogEntry,
  resetServerLogsForTest,
  ringSnapshot,
} from '../../lib/server-logs.js';

async function rows(): Array<{ id: number; message: string }> {
  return (await getDb().all('SELECT id, message FROM server_logs ORDER BY id')) as Array<{ id: number; message: string }>;
}

describe('server_logs persist rate cap', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  beforeEach(async () => {
    (await getDb().run('DELETE FROM server_logs'));
    resetServerLogsForTest();
    await initServerLogs();
  });

  it('persists at most PERSIST_MAX_PER_SECOND rows per second, then one summary row', async () => {
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 200; i++) await recordLogEntry({ level: 'error', message: `storm ${i}`, tsMs: t0 + i });
    expect(await rows()).toHaveLength(PERSIST_MAX_PER_SECOND);
    // Every line still reached the live view.
    expect(ringSnapshot().filter(e => e.message.startsWith('storm'))).toHaveLength(200);

    await recordLogEntry({ level: 'warn', message: 'after the storm', tsMs: t0 + 1500 });
    const all = await rows();
    expect(all).toHaveLength(PERSIST_MAX_PER_SECOND + 2);
    expect(all[all.length - 2]!.message).toContain(`${200 - PERSIST_MAX_PER_SECOND} warn/error lines not persisted`);
    expect(all[all.length - 1]!.message).toBe('after the storm');

    // Ids in the ring stay strictly increasing (the dashboard's sinceId cursor relies on it).
    const ids = ringSnapshot().map(e => e.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not cap a normal rate, and info lines never count', async () => {
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 1000; i++) await recordLogEntry({ level: 'info', message: `info ${i}`, tsMs: t0 });
    for (let s = 0; s < 5; s++) {
      for (let i = 0; i < 10; i++) await recordLogEntry({ level: 'warn', message: `w ${s}.${i}`, tsMs: t0 + s * 1000 + i });
    }
    expect(await rows()).toHaveLength(50);
    expect((await rows()).some(r => r.message.includes('not persisted'))).toBe(false);
  });
});
