import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MIN_CONTEXT_WINDOW_SETTING,
  MIN_CONTEXT_WINDOW_PRESETS,
  minContextWindowFloor,
  passesContextWindowFloor,
} from '../../lib/min-context-window.js';
import { getDb, setSetting, getSetting } from '../../db/index.js';
import { initTestDb } from '../helpers/test-db.js';

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  await initTestDb();
});

afterEach(async () => {
  (await getDb().run('DELETE FROM settings WHERE key = ?', [MIN_CONTEXT_WINDOW_SETTING]));
});

describe('minContextWindowFloor', () => {
  it('is disabled by default (off / unset)', async () => {
    expect(await minContextWindowFloor()).toBeNull();
    await setSetting(MIN_CONTEXT_WINDOW_SETTING, 'off');
    expect(await minContextWindowFloor()).toBeNull();
  });

  it('resolves the named presets to their token counts', async () => {
    for (const [key, tokens] of Object.entries(MIN_CONTEXT_WINDOW_PRESETS)) {
      await setSetting(MIN_CONTEXT_WINDOW_SETTING, key);
      expect(await minContextWindowFloor()).toBe(tokens);
    }
  });

  it('is case-insensitive', async () => {
    await setSetting(MIN_CONTEXT_WINDOW_SETTING, '128K');
    expect(await minContextWindowFloor()).toBe(131_072);
  });

  it('treats garbage as disabled so a bad value can never empty the pool', async () => {
    for (const raw of ['banana', '-1', '1.5', 'NaN', 'Infinity', '{}']) {
      await setSetting(MIN_CONTEXT_WINDOW_SETTING, raw);
      expect(await minContextWindowFloor()).toBeNull();
    }
  });
});

describe('passesContextWindowFloor', () => {
  it('passes everything while disabled', async () => {
    expect(await passesContextWindowFloor(8_000)).toBe(true);
    expect(await passesContextWindowFloor(null)).toBe(true);
  });

  it('is upward-compatible: 128k keeps 512k and 1M models', async () => {
    await setSetting(MIN_CONTEXT_WINDOW_SETTING, '128k');
    expect(await passesContextWindowFloor(131_072)).toBe(true);
    expect(await passesContextWindowFloor(524_288)).toBe(true);
    expect(await passesContextWindowFloor(1_048_576)).toBe(true);
    expect(await passesContextWindowFloor(32_768)).toBe(false);
  });

  it('never filters an unknown (null) window', async () => {
    await setSetting(MIN_CONTEXT_WINDOW_SETTING, '1m');
    expect(await passesContextWindowFloor(null)).toBe(true);
    expect(await passesContextWindowFloor(undefined)).toBe(true);
  });

  it('rejects models strictly below the floor', async () => {
    await setSetting(MIN_CONTEXT_WINDOW_SETTING, '32k');
    expect(await passesContextWindowFloor(16_000)).toBe(false);
    expect(await passesContextWindowFloor(32_768)).toBe(true);
  });

  it('reads through the same settings row the PUT endpoint writes', async () => {
    await setSetting(MIN_CONTEXT_WINDOW_SETTING, '512k');
    expect(await getSetting(MIN_CONTEXT_WINDOW_SETTING)).toBe('512k');
    expect(await minContextWindowFloor()).toBe(524_288);
  });
});
