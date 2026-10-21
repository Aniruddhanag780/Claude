import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey } from '../../db/index.js';
import { initTestDb } from '../helpers/test-db.js';

async function post(app: Express, path: string, body: any, key: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}

const IMAGE_MESSAGE = {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'what is in this image?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
    ],
  }],
};

describe('Vision-aware routing (#118, #125)', () => {
  let app: Express;
  let key: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
    app = createApp();
    key = await getUnifiedApiKey();
  });

  it('seeds supports_vision: true for vision models, false for text-only', async () => {
    const db = getDb();
    const vision = (await db.get("SELECT supports_vision FROM models WHERE model_id = 'gemini-2.5-flash'")) as { supports_vision: number };
    expect(vision.supports_vision).toBe(1);

    // The known vision set is flagged; plenty of text-only models remain at 0.
    const visionCount = ((await db.get('SELECT COUNT(*) c FROM models WHERE supports_vision = 1')) as { c: number }).c;
    const textCount = ((await db.get('SELECT COUNT(*) c FROM models WHERE supports_vision = 0')) as { c: number }).c;
    expect(visionCount).toBeGreaterThanOrEqual(4);
    expect(textCount).toBeGreaterThan(0);
  });

  it('lets an image request through routing when a vision model is enabled (no 422)', async () => {
    // Seed has Gemini/Llama-4 vision models enabled but no provider keys, so
    // routing exhausts → 429. The point: it is NOT the 422 "no vision model"
    // error, proving the precheck passed and routing was attempted.
    const { status, body } = await post(app, '/v1/chat/completions', IMAGE_MESSAGE, key);
    expect(status).not.toBe(422);
    expect(body?.error?.code).not.toBe('no_vision_model');
  });

  it('rejects an image request with a clear 422 when no vision model is enabled', async () => {
    // Disable every vision-capable model in the chain.
    (await getDb().run('UPDATE models SET enabled = 0 WHERE supports_vision = 1'));

    const { status, body } = await post(app, '/v1/chat/completions', IMAGE_MESSAGE, key);
    expect(status).toBe(422);
    expect(body.error.code).toBe('no_vision_model');
    expect(body.error.type).toBe('invalid_request_error');

    // Restore so we don't leak state to other expectations.
    (await getDb().run('UPDATE models SET enabled = 1 WHERE supports_vision = 1'));
  });

  it('does not apply the vision gate to a text-only request', async () => {
    // Disable all vision models; a plain text request must still route normally
    // (it 429s on exhaustion here, but never the 422 vision error).
    (await getDb().run('UPDATE models SET enabled = 0 WHERE supports_vision = 1'));
    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, key);
    expect(status).not.toBe(422);
    expect(body?.error?.code).not.toBe('no_vision_model');
    (await getDb().run('UPDATE models SET enabled = 1 WHERE supports_vision = 1'));
  });

  it('lets a fusion image request through routing (no 422 fusion_no_vision)', async () => {
    // Same seed as the auto case: vision models enabled but no provider keys,
    // so routing exhausts. The point is that fusion is NOT rejected up front.
    const { status, body } = await post(app, '/v1/chat/completions', { ...IMAGE_MESSAGE, model: 'fusion' }, key);
    expect(status).not.toBe(422);
    expect(body?.error?.code).not.toBe('fusion_no_vision');
  });
});
