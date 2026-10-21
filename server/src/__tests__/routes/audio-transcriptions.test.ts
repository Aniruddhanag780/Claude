import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { MAX_TRANSCRIPTION_BYTES } from '../../services/media.js';
import { clearCooldownsForKey } from '../../services/ratelimit.js';
import { initTestDb } from '../helpers/test-db.js';

const realFetch = globalThis.fetch;

async function addKey(platform: string, raw = `${platform}-test-key`): number {
  const { encrypted, iv, authTag } = encrypt(raw);
  const row = (await getDb().run(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1) RETURNING id`, [platform, encrypted, iv, authTag]));
  return Number(row.lastInsertRowid);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Seed the catalog-delivered STT registry (media_models, modality
 *  'transcription') exactly as the published `transcriptionModels` fragment
 *  would land it via catalog-sync. */
async function seedTranscriptionModels(): void {
  (await getDb().run(`
    INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, meta_json)
    VALUES (?, ?, ?, 'transcription', ?, 1, '', ?) RETURNING id`, ['groq', 'whisper-large-v3-turbo', 'Whisper Large v3 Turbo (Groq)', 0, JSON.stringify({ maxBytes: 25 * 1024 * 1024 })]));
  (await getDb().run(`
    INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, meta_json)
    VALUES (?, ?, ?, 'transcription', ?, 1, '', ?) RETURNING id`, ['groq', 'whisper-large-v3', 'Whisper Large v3 (Groq)', 1, JSON.stringify({ maxBytes: 25 * 1024 * 1024 })]));
  (await getDb().run(`
    INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, meta_json)
    VALUES (?, ?, ?, 'transcription', ?, 1, '', ?) RETURNING id`, ['cloudflare', '@cf/openai/whisper-large-v3-turbo', 'Whisper Large v3 Turbo (Cloudflare Workers AI)', 2, JSON.stringify({ subtitleFormats: ['vtt'], requestStyle: 'json' })]));
  (await getDb().run(`
    INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, meta_json)
    VALUES (?, ?, ?, 'transcription', ?, 1, '', ?) RETURNING id`, ['cloudflare', '@cf/openai/whisper', 'Whisper (Cloudflare Workers AI)', 3, JSON.stringify({ subtitleFormats: ['vtt'], requestStyle: 'binary' })]));
}

interface MultipartOpts {
  file?: { bytes: Buffer; name: string; type?: string } | null;
  fields?: Record<string, string>;
  auth?: string | null;
}

/** POST multipart/form-data to /v1/audio/transcriptions on a live listener,
 *  using the saved real fetch so a mocked globalThis.fetch only intercepts
 *  upstream provider calls. */
async function postTranscription(app: Express, opts: MultipartOpts) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const form = new FormData();
  if (opts.file) {
    form.append('file', new Blob([opts.file.bytes], { type: opts.file.type ?? 'audio/wav' }), opts.file.name);
  }
  for (const [k, v] of Object.entries(opts.fields ?? {})) form.append(k, v);
  const headers: Record<string, string> = {};
  if (opts.auth !== null) headers.Authorization = `Bearer ${opts.auth ?? await getUnifiedApiKey()}`;
  const res = await realFetch(`http://127.0.0.1:${addr.port}/v1/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: form,
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, body: json, raw, headers: res.headers };
}

const AUDIO = Buffer.from('RIFFfakewavbytes');

describe('POST /v1/audio/transcriptions', () => {
  let app: Express;

  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
    for (let id = 1; id <= 10; id++) await clearCooldownsForKey(id);
    await seedTranscriptionModels();
    app = createApp();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('401 without an API key', async () => {
    const { status, body } = await postTranscription(app, {
      file: { bytes: AUDIO, name: 'a.wav' },
      fields: { model: 'whisper-1' },
      auth: null,
    });
    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('401 with a wrong key', async () => {
    const { status, body } = await postTranscription(app, {
      file: { bytes: AUDIO, name: 'a.wav' },
      fields: { model: 'whisper-1' },
      auth: 'freellmapi-wrong-key',
    });
    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('400 when the file part is missing', async () => {
    const { status, body } = await postTranscription(app, {
      file: null,
      fields: { model: 'whisper-1' },
    });
    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('file');
  });

  it('400 when model is missing', async () => {
    const { status, body } = await postTranscription(app, {
      file: { bytes: AUDIO, name: 'a.wav' },
    });
    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('model');
  });

  it('413 OpenAI-shaped error when the upload exceeds the size limit', async () => {
    const big = Buffer.alloc(MAX_TRANSCRIPTION_BYTES + 1);
    const { status, body } = await postTranscription(app, {
      file: { bytes: big, name: 'big.wav' },
      fields: { model: 'whisper-1' },
    });
    expect(status).toBe(413);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('file_too_large');
  });

  it("400 unsupported_format for response_format 'srt'", async () => {
    const { status, body } = await postTranscription(app, {
      file: { bytes: AUDIO, name: 'a.wav' },
      fields: { model: 'whisper-1', response_format: 'srt' },
    });
    expect(status).toBe(400);
    expect(body.error.code).toBe('unsupported_format');
  });

  it('400 for an unrecognized response_format', async () => {
    const { status, body } = await postTranscription(app, {
      file: { bytes: AUDIO, name: 'a.wav' },
      fields: { model: 'whisper-1', response_format: 'yaml' },
    });
    expect(status).toBe(400);
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('400 for an out-of-range temperature', async () => {
    const { status, body } = await postTranscription(app, {
      file: { bytes: AUDIO, name: 'a.wav' },
      fields: { model: 'whisper-1', temperature: '3' },
    });
    expect(status).toBe(400);
    expect(body.error.message).toContain('temperature');
  });

  it('default json format returns {"text": ...} and provider headers', async () => {
    await addKey('groq');
    globalThis.fetch = vi.fn(async () => jsonResponse({ text: 'hello from groq' })) as any;
    const { status, body, headers } = await postTranscription(app, {
      file: { bytes: AUDIO, name: 'a.wav' },
      fields: { model: 'whisper-1' },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ text: 'hello from groq' });
    expect(headers.get('x-provider')).toBe('groq');
  });

  it("response_format 'text' returns the plain string", async () => {
    await addKey('groq');
    globalThis.fetch = vi.fn(async () => jsonResponse({ text: 'plain words' })) as any;
    const { status, raw, headers } = await postTranscription(app, {
      file: { bytes: AUDIO, name: 'a.wav' },
      fields: { model: 'whisper-1', response_format: 'text' },
    });
    expect(status).toBe(200);
    expect(raw).toBe('plain words');
    expect(headers.get('content-type')).toContain('text/plain');
  });

  it("response_format 'verbose_json' returns the OpenAI verbose shape when segments exist", async () => {
    await addKey('groq');
    const segments = [{ id: 0, start: 0, end: 1, text: 'hi' }];
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ text: 'hi', language: 'en', duration: 1, segments })) as any;
    const { status, body } = await postTranscription(app, {
      file: { bytes: AUDIO, name: 'a.wav' },
      fields: { model: 'whisper-1', response_format: 'verbose_json' },
    });
    expect(status).toBe(200);
    expect(body.task).toBe('transcribe');
    expect(body.language).toBe('en');
    expect(body.duration).toBe(1);
    expect(body.segments).toEqual(segments);
  });

  it("'verbose_json' falls back to the plain json shape when the provider has no segments", async () => {
    await addKey('groq');
    globalThis.fetch = vi.fn(async () => jsonResponse({ text: 'no segments here' })) as any;
    const { status, body } = await postTranscription(app, {
      file: { bytes: AUDIO, name: 'a.wav' },
      fields: { model: 'whisper-1', response_format: 'verbose_json' },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ text: 'no segments here' });
  });

  it('falls over to cloudflare when groq is rate-limited (429)', async () => {
    await addKey('groq');
    await addKey('cloudflare', 'acct123:token456');
    globalThis.fetch = vi.fn(async (url: any) => {
      if (String(url).includes('groq.com')) return jsonResponse({ error: { message: 'slow down' } }, 429);
      return jsonResponse({ result: { text: 'cf text' }, success: true });
    }) as any;
    const { status, body, headers } = await postTranscription(app, {
      file: { bytes: AUDIO, name: 'a.wav' },
      fields: { model: 'whisper-1' },
    });
    expect(status).toBe(200);
    expect(body).toEqual({ text: 'cf text' });
    expect(headers.get('x-provider')).toBe('cloudflare');
  });

  it('429 rate_limit_error when every provider is rate-limited', async () => {
    await addKey('groq');
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: { message: 'slow down' } }, 429)) as any;
    const { status, body } = await postTranscription(app, {
      file: { bytes: AUDIO, name: 'a.wav' },
      fields: { model: 'whisper-1' },
    });
    expect(status).toBe(429);
    expect(body.error.type).toBe('rate_limit_error');
  });

  it("503 with code 'no_transcription_models' when the registry has never been synced", async () => {
    (await getDb().run("DELETE FROM media_models WHERE modality = 'transcription'"));
    await addKey('groq');
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
    const { status, body } = await postTranscription(app, {
      file: { bytes: AUDIO, name: 'a.wav' },
      fields: { model: 'whisper-1' },
    });
    expect(status).toBe(503);
    expect(body.error.type).toBe('server_error');
    expect(body.error.code).toBe('no_transcription_models');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("response_format 'vtt' streams native subtitles from cloudflare", async () => {
    await addKey('cloudflare', 'acct123:token456');
    const vtt = 'WEBVTT\n\n00:00.000 --> 00:01.000\nhello';
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ result: { text: 'hello', vtt }, success: true })) as any;
    const { status, raw, headers } = await postTranscription(app, {
      file: { bytes: AUDIO, name: 'a.wav' },
      fields: { model: '@cf/openai/whisper', response_format: 'vtt' },
    });
    expect(status).toBe(200);
    expect(raw).toBe(vtt);
    expect(headers.get('content-type')).toContain('text/vtt');
  });
});
