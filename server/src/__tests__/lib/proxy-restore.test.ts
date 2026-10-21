import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { getDb, setSetting } from '../../db/index.js';
import { initTestDb } from '../helpers/test-db.js';
import {
  restoreProxySettings,
  getProxyUrl,
  getProxyMode,
  getFetchRelayToken,
  isProxyEnabled,
  getProxyBypassPlatforms,
  getNoProxyRules,
  applyProxyUrl,
  applyProxyMode,
  applyProxyEnabled,
  applyProxyBypass,
  applyFetchRelayToken,
  encodeFetchRelayToken,
} from '../../lib/proxy.js';

// #838 reads the OS-wide proxy (scutil/reg/gsettings) as a last-resort
// fallback when neither the env nor the DB configures one. A developer
// machine can genuinely have that set (macOS System Settings → Proxies),
// which fails every "no proxy configured" case below for the same reason
// clearProxyEnv() exists — the ambient system, not the code under test.
// '' parses as "no proxy" in every platform branch, so the suite sees a
// clean machine regardless of the host's system settings.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  execFileSync: () => '',
}));

// #949: the desktop embedder builds the app without server/src/index.ts, so
// the proxy state it starts with is whatever the module defaults are — an
// empty URL. The URL the user saved through PUT /api/settings/proxy sits in
// the settings table, ignored until the next re-save. restoreProxySettings()
// is the single hydration step both entry points now call after initDb; this
// test pins that the DB value actually reaches the process state.

const PROXY_ENV_VARS = ['PROXY_URL', 'PROXY_MODE', 'FETCH_RELAY_TOKEN', 'ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];

function clearProxyEnv(): void {
  for (const name of PROXY_ENV_VARS) {
    delete process.env[name];
    delete process.env[name.toLowerCase()];
  }
}

let closed = false;

beforeEach(() => {
  clearProxyEnv();
  // Reset to the module defaults so each case starts from "fresh process".
  applyProxyUrl('');
  applyProxyMode('forward');
  applyFetchRelayToken('');
  applyProxyEnabled(true);
  applyProxyBypass('');
});

afterAll(() => {
  if (!closed) {
    getDb().close();
    closed = true;
  }
});

describe('restoreProxySettings (desktop embedder hydration, #949)', () => {
  it('loads a saved proxy URL, enabled flag and bypass list from the settings table', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
    await setSetting('proxy_url', 'socks5h://127.0.0.1:9050');
    await setSetting('proxy_enabled', '1');
    await setSetting('proxy_bypass', 'groq,openrouter');

    await restoreProxySettings();

    expect(getProxyUrl()).toBe('socks5h://127.0.0.1:9050');
    expect(isProxyEnabled()).toBe(true);
    expect(getProxyBypassPlatforms()).toEqual(['groq', 'openrouter']);
  });

  it('respects a disabled proxy saved across a restart', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
    await setSetting('proxy_url', 'http://127.0.0.1:3128');
    await setSetting('proxy_enabled', '0');

    await restoreProxySettings();

    expect(getProxyUrl()).toBe('http://127.0.0.1:3128');
    expect(isProxyEnabled()).toBe(false);
  });

  it('keeps the defaults when nothing was ever saved', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();

    await restoreProxySettings();

    expect(getProxyUrl()).toBe('');
    expect(getProxyMode()).toBe('forward');
    expect(isProxyEnabled()).toBe(true);
    expect(getProxyBypassPlatforms()).toEqual([]);
  });

  it('lets the PROXY_URL env var outrank the saved value, as before', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
    await setSetting('proxy_url', 'http://saved:3128');
    process.env.PROXY_URL = 'http://env:8080';

    await restoreProxySettings();

    expect(getProxyUrl()).toBe('http://env:8080');
    expect(getProxyMode()).toBe('forward');
  });

  it('restores an explicitly saved Fetch Relay mode', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
    await setSetting('proxy_url', 'https://relay.example.test/secret');
    await setSetting('proxy_mode', 'fetch-relay');

    await restoreProxySettings();

    expect(getProxyUrl()).toBe('https://relay.example.test/secret');
    expect(getProxyMode()).toBe('fetch-relay');
  });

  it('restores a saved Relay token and lets FETCH_RELAY_TOKEN override it', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
    await setSetting('fetch_relay_token', encodeFetchRelayToken('saved-token'));

    await restoreProxySettings();
    expect(getFetchRelayToken()).toBe('saved-token');

    process.env.FETCH_RELAY_TOKEN = 'environment-token';
    await restoreProxySettings();
    expect(getFetchRelayToken()).toBe('environment-token');
  });

  it('lets PROXY_MODE opt an environment PROXY_URL into Fetch Relay', async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
    process.env.PROXY_URL = 'https://relay.example.test/secret';
    process.env.PROXY_MODE = 'fetch-relay';

    await restoreProxySettings();

    expect(getProxyMode()).toBe('fetch-relay');
  });
});

// The env tiers below are resolveProxySource()'s job, but restore time is the
// only moment they are consulted on a desktop start: the embedder hydrates
// once and then nothing re-reads the environment. A regression that skipped a
// tier here would strand a user who has only ever exported HTTPS_PROXY.
describe('restoreProxySettings + the standard env fallbacks (#353 x #949)', () => {
  async function freshDb(): void {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  }

  it('falls back to ALL_PROXY when nothing was saved in the dashboard', async () => {
    await freshDb();
    process.env.ALL_PROXY = 'socks5://all:1080';

    await restoreProxySettings();

    expect(getProxyUrl()).toBe('socks5://all:1080');
  });

  it('falls back to HTTPS_PROXY', async () => {
    await freshDb();
    process.env.HTTPS_PROXY = 'http://https-tier:8443';

    await restoreProxySettings();

    expect(getProxyUrl()).toBe('http://https-tier:8443');
  });

  it('falls back to HTTP_PROXY', async () => {
    await freshDb();
    process.env.HTTP_PROXY = 'http://http-tier:8080';

    await restoreProxySettings();

    expect(getProxyUrl()).toBe('http://http-tier:8080');
  });

  it('prefers ALL_PROXY, then HTTPS_PROXY, then HTTP_PROXY', async () => {
    await freshDb();
    process.env.ALL_PROXY = 'http://all:1';
    process.env.HTTPS_PROXY = 'http://https:2';
    process.env.HTTP_PROXY = 'http://http:3';

    await restoreProxySettings();

    expect(getProxyUrl()).toBe('http://all:1');
  });

  it('reads the lower-case spelling too — the one curl/git users actually export', async () => {
    await freshDb();
    process.env.https_proxy = 'http://lower:8443';

    await restoreProxySettings();

    expect(getProxyUrl()).toBe('http://lower:8443');
  });

  it('does NOT let the ambient env override a proxy the user typed into the dashboard', async () => {
    await freshDb();
    await setSetting('proxy_url', 'http://saved:3128');
    process.env.ALL_PROXY = 'http://ambient:1080';
    process.env.HTTPS_PROXY = 'http://ambient:8443';
    process.env.HTTP_PROXY = 'http://ambient:8080';

    await restoreProxySettings();

    expect(getProxyUrl()).toBe('http://saved:3128');
  });

  it('still lets PROXY_URL outrank the ambient vars', async () => {
    await freshDb();
    process.env.PROXY_URL = 'http://explicit:9090';
    process.env.ALL_PROXY = 'http://ambient:1080';

    await restoreProxySettings();

    expect(getProxyUrl()).toBe('http://explicit:9090');
  });

  it('leaves the proxy empty when neither the DB nor any env var has one', async () => {
    await freshDb();

    await restoreProxySettings();

    expect(getProxyUrl()).toBe('');
  });
});

// NO_PROXY is read from the environment inside applyProxyUrl, so on the
// desktop path it is parsed exactly once: during restore. If restore stopped
// going through applyProxyUrl the saved URL might still land while the direct
// list silently emptied, quietly proxying hosts the user excluded.
describe('restoreProxySettings + NO_PROXY (#949)', () => {
  async function freshDb(): void {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  }

  it('parses NO_PROXY at restore time, lower-cased and trimmed', async () => {
    await freshDb();
    await setSetting('proxy_url', 'http://127.0.0.1:3128');
    process.env.NO_PROXY = 'localhost, .Internal.Corp ,, 10.0.0.1';

    await restoreProxySettings();

    expect(getNoProxyRules()).toEqual(['localhost', '.internal.corp', '10.0.0.1']);
  });

  it('normalises the `*.domain` spelling to the leading-dot form', async () => {
    await freshDb();
    await setSetting('proxy_url', 'http://127.0.0.1:3128');
    process.env.NO_PROXY = '*.example.com';

    await restoreProxySettings();

    expect(getNoProxyRules()).toEqual(['.example.com']);
  });

  it('honours the lower-case no_proxy spelling', async () => {
    await freshDb();
    await setSetting('proxy_url', 'http://127.0.0.1:3128');
    process.env.no_proxy = 'example.com';

    await restoreProxySettings();

    expect(getNoProxyRules()).toEqual(['example.com']);
  });

  it('applies NO_PROXY even when the proxy itself came from the env tier', async () => {
    await freshDb();
    process.env.HTTPS_PROXY = 'http://ambient:8443';
    process.env.NO_PROXY = 'internal.corp';

    await restoreProxySettings();

    expect(getProxyUrl()).toBe('http://ambient:8443');
    expect(getNoProxyRules()).toEqual(['internal.corp']);
  });

  it('clears stale rules when the env no longer sets NO_PROXY', async () => {
    await freshDb();
    await setSetting('proxy_url', 'http://127.0.0.1:3128');
    process.env.NO_PROXY = 'example.com';
    await restoreProxySettings();
    expect(getNoProxyRules()).toEqual(['example.com']);

    delete process.env.NO_PROXY;
    await restoreProxySettings();

    expect(getNoProxyRules()).toEqual([]);
  });
});
