import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb } from '../../db/index.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { initTestDb } from '../helpers/test-db.js';

// #687: exporting every key and importing the file back has to return the
// custom OpenAI-compatible endpoints too. They were dropped three ways at once:
// .env and .csv carried no base_url, the importer refused platform 'custom'
// outright, and the dialog counted rows the export then skipped.

let dashToken = '';

async function exportText(app: Express, format: string): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys/export?format=${format}`, {
    headers: { Authorization: `Bearer ${dashToken}`, 'x-reauth-password': 'password123' },
  });
  const text = await res.text();
  server.close();
  return text;
}

async function importFile(app: Express, filename: string, content: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'text/plain' }), filename);
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${dashToken}` },
    body: form,
  });
  const body = await res.json();
  server.close();
  return { status: res.status, body };
}

async function listKeys(app: Express) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}/api/keys`, {
    headers: { Authorization: `Bearer ${dashToken}` },
  });
  const body = await res.json();
  server.close();
  return body as any[];
}

async function addKey(platform: string, raw: string, label: string, baseUrl: string | null = null) {
  const { encrypted, iv, authTag } = encrypt(raw);
  (await getDb().run(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1, ?) RETURNING id`, [platform, label, encrypted, iv, authTag, baseUrl]));
}

/** Every stored row as "platform|baseUrl|secret", for comparing before/after. */
async function snapshot(): string[] {
  return ((await getDb().all('SELECT platform, base_url, encrypted_key, iv, auth_tag FROM api_keys')) as any[])
    .map(r => {
      let secret = '';
      try { secret = decrypt(r.encrypted_key, r.iv, r.auth_tag); } catch { secret = '[undecryptable]'; }
      return `${r.platform}|${r.base_url ?? ''}|${secret}`;
    })
    .sort();
}

async function seed() {
  (await getDb().run('DELETE FROM api_keys'));
  await addKey('google', 'goog-secret-1', 'first google');
  await addKey('google', 'goog-secret-2', 'second google');
  await addKey('custom', 'lmstudio-secret', 'LM Studio', 'http://192.168.1.5:1234/v1');
  await addKey('custom', 'vllm-secret', 'vLLM box', 'http://10.0.0.9:8000/v1');
  await addKey('custom', 'no-key', 'Local no-auth', 'http://127.0.0.1:8080/v1');
}

describe('#687 custom endpoints survive an export/import round trip', () => {
  let app: Express;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    // Private addresses must stay importable — a custom endpoint is usually a
    // box on the LAN. The SSRF guard only blocks them when this is set.
    delete process.env.FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS;
    await initTestDb();
    app = createApp();
    dashToken = await mintDashboardToken();
  });

  beforeEach(async () => await seed());

  it('.env pairs each endpoint with its base_url and keeps repeat platforms apart', async () => {
    const text = await exportText(app, 'env');
    expect(text).toContain('CUSTOM_1_BASE_URL=http://192.168.1.5:1234/v1');
    expect(text).toContain('CUSTOM_1_KEY=lmstudio-secret');
    expect(text).toContain('CUSTOM_2_BASE_URL=http://10.0.0.9:8000/v1');
    // Two Google keys must not collapse onto one name.
    expect(text).toContain('GOOGLE_KEY=goog-secret-1');
    expect(text).toContain('GOOGLE_KEY_2=goog-secret-2');
  });

  it('.csv carries base_url as a fourth column', async () => {
    const text = await exportText(app, 'csv');
    expect(text.split('\n')[0]).toBe('platform,key,label,base_url');
    expect(text).toContain('"custom","lmstudio-secret","LM Studio","http://192.168.1.5:1234/v1"');
    expect(text).toContain('"google","goog-secret-1","first google",""');
  });

  it.each(['env', 'csv', 'json'])('a %s export re-imports into the same set of keys', async (format) => {
    const before = await snapshot();
    const text = await exportText(app, format);

    (await getDb().run('DELETE FROM api_keys'));
    const { body } = await importFile(app, `keys.${format}`, text);
    expect(body.errors).toEqual([]);

    expect(await snapshot()).toEqual(before);
  });

  it.each(['csv', 'json'])('a %s export keeps awkward labels and secrets intact on re-import', async (format) => {
    (await getDb().run('DELETE FROM api_keys'));
    // '=' in a label used to split the stored rawKey in the wrong place,
    // truncating the label and prepending its tail to the secret. The export's
    // formula guard also writes =/+/-/@ labels with a leading quote.
    await addKey('groq', 'gsk-eq', 'team=alpha');
    await addKey('groq', 'gsk-formula', '=HYPERLINK("x")');
    await addKey('google', 'goog-comma', 'work, "primary"');
    await addKey('google', 'goog-dash', '-backup');
    const labelled = async () => ((await getDb().all('SELECT platform, label, encrypted_key, iv, auth_tag FROM api_keys')) as any[])
      .map(r => `${r.platform}|${r.label}|${decrypt(r.encrypted_key, r.iv, r.auth_tag)}`)
      .sort();
    const before = await labelled();
    const text = await exportText(app, format);

    (await getDb().run('DELETE FROM api_keys'));
    const { body } = await importFile(app, `keys.${format}`, text);
    expect(body.errors).toEqual([]);
    expect(await labelled()).toEqual(before);
  });

  it('a custom key with no base_url is skipped rather than orphaned', async () => {
    (await getDb().run('DELETE FROM api_keys'));
    const { body } = await importFile(app, 'keys.csv', 'platform,key,label,base_url\n"custom","orphan","No URL",""\n');
    expect(body.imported).toBe(0);
    expect(body.skipped.length).toBe(1);
    expect((await getDb().get('SELECT COUNT(*) AS c FROM api_keys'))).toEqual({ c: 0 });
  });

  it('an import file naming a blocked address is refused, not stored', async () => {
    process.env.FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS = '1';
    try {
      (await getDb().run('DELETE FROM api_keys'));
      const { body } = await importFile(
        app, 'keys.csv',
        'platform,key,label,base_url\n"custom","k","Metadata","http://169.254.169.254/v1"\n',
      );
      expect(body.imported).toBe(0);
      expect(body.errors[0].error).toMatch(/baseUrl rejected/);
      expect((await getDb().get('SELECT COUNT(*) AS c FROM api_keys'))).toEqual({ c: 0 });
    } finally {
      delete process.env.FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS;
    }
  });

  it('the dialog count matches what the export writes', async () => {
    const keys = await listKeys(app);
    const promised = keys.filter(k => k.exportable).length;
    const written = JSON.parse(await exportText(app, 'json')).keys.length;
    expect(promised).toBe(written);
    // All five rows, including the no-auth endpoint that used to be dropped.
    expect(written).toBe(5);
  });
});
