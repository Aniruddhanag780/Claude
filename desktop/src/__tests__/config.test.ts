import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A corrupt or half-written config.json used to be read as {} and then
// overwritten by the next saveConfig, silently dropping the user's settings.

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freeapi-config-'));

vi.mock('electron', () => ({
  app: { getPath: () => userData },
}));

const { loadConfig, saveConfig } = await import('../config.js');
const configFile = path.join(userData, 'config.json');

afterAll(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('desktop config persistence', () => {
  beforeEach(() => {
    for (const f of fs.readdirSync(userData)) fs.rmSync(path.join(userData, f), { force: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns defaults without complaint when no config exists yet', () => {
    expect(loadConfig()).toEqual({});
    expect(console.error).not.toHaveBeenCalled();
  });

  it('round-trips a saved config and leaves no temp files behind', () => {
    saveConfig({ port: 4123, theme: 'dark' });
    expect(loadConfig()).toEqual({ port: 4123, theme: 'dark' });
    expect(fs.readdirSync(userData)).toEqual(['config.json']);
  });

  it('moves a corrupt config aside instead of letting the next save overwrite it', () => {
    fs.writeFileSync(configFile, '{"port": 41');

    expect(loadConfig()).toEqual({});
    expect(console.error).toHaveBeenCalled();
    const quarantined = fs.readdirSync(userData).filter(f => f.startsWith('config.json.corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect(fs.readFileSync(path.join(userData, quarantined[0]), 'utf8')).toBe('{"port": 41');

    saveConfig({ theme: 'light' });
    expect(loadConfig()).toEqual({ theme: 'light' });
    // The original bytes are still there for the user to recover from.
    expect(fs.readFileSync(path.join(userData, quarantined[0]), 'utf8')).toBe('{"port": 41');
  });

  it('treats a non-object JSON root as corrupt', () => {
    fs.writeFileSync(configFile, 'null');
    expect(loadConfig()).toEqual({});
    expect(fs.readdirSync(userData).some(f => f.startsWith('config.json.corrupt-'))).toBe(true);
  });
});
