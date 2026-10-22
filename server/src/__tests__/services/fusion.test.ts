import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { resolveFusionCandidate, setRoutingStrategy } from '../../services/router.js';
import { initTestDb } from '../helpers/test-db.js';

// A fusion unit-test fixture: seed the standard catalog, then add one healthy
// key per platform so the auto-panel chain has servable members (the seed ships
// no keys by default). Priority strategy keeps the panel order deterministic.
async function addKey(platform: string): void {
  const { encrypted, iv, authTag } = encrypt(`test-${platform}-key`);
  (await getDb().run(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'fusion-vision-test', ?, ?, ?, 'healthy', 1) RETURNING id`, [platform, encrypted, iv, authTag]));
}

describe('selectPanel vision filtering', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
    await setRoutingStrategy('priority');
  });

  beforeEach(async () => {
    const db = getDb();
    (await db.run('DELETE FROM api_keys'));
    (await db.run("DELETE FROM settings WHERE key = 'active_profile_id'"));
    const models = (await db.all('SELECT id, intelligence_rank FROM models ORDER BY intelligence_rank ASC')) as any[];
    for (let i = 0; i < models.length; i++) (await db.run('UPDATE fallback_config SET priority = ? WHERE model_db_id = ?', [i + 1, models[i].id]));
    await addKey('google');
    await addKey('groq');
  });

  it('drops explicit panel models without vision support when requireVision', async () => {
    const { selectPanel } = await import('../../services/fusion.js');
    const config = { models: ['gemini-2.5-flash', 'llama-3.1-8b-instant'], k: 2, judge: null, strategy: 'synthesize' as const, expose_panel: false };
    const { panel, dropped } = await selectPanel(config, { requireVision: true, estimatedTokens: 100 });
    expect(panel.every((c) => c.supportsVision === 1)).toBe(true);
    expect(panel.some((c) => c.modelId === 'gemini-2.5-flash')).toBe(true);
    expect(panel.some((c) => c.modelId === 'llama-3.1-8b-instant')).toBe(false);
    expect(dropped).toContain('llama-3.1-8b-instant (no vision support)');
  });

  it('auto panel only contains vision models when requireVision', async () => {
    const { selectPanel } = await import('../../services/fusion.js');
    const config = { k: 4, judge: null, strategy: 'synthesize' as const, expose_panel: false };
    const { panel } = await selectPanel(config, { requireVision: true, estimatedTokens: 100 });
    expect(panel.length).toBeGreaterThan(0);
    expect(panel.every((c) => c.supportsVision === 1)).toBe(true);
  });

  it('explicit unified aliases prefer a keyed provider over a keyless duplicate', async () => {
    const db = getDb();
    // Make the keyless row win the normal deterministic ordering. The fusion
    // resolver must still choose the configured provider for the same logical
    // alias rather than spending a panel slot on a dead relay.
    (await db.run(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
      VALUES (?, ?, ?, ?, ?, 1) RETURNING id`, ['kilo', 'edge-case-model', 'Edge Case Model (Kilo)', 1, 1]));
    (await db.run(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
      VALUES (?, ?, ?, ?, ?, 1) RETURNING id`, ['nvidia', 'edge-case-model', 'Edge Case Model (NVIDIA)', 2, 2]));
    await addKey('nvidia');

    try {
      const candidate = await resolveFusionCandidate('edge-case-model');
      expect(candidate?.platform).toBe('nvidia');
      expect(candidate?.modelId).toBe('edge-case-model');
    } finally {
      (await db.run("DELETE FROM models WHERE model_id = 'edge-case-model'"));
    }
  });
});

describe('fusion vision judge', () => {
  it('buildJudgeMessages strips image blocks when vision is requested', async () => {
    const { buildJudgeMessages } = await import('../../services/fusion.js');
    const original = [
      { role: 'user' as const, content: [
        { type: 'text', text: 'what is in this image?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ] },
    ];
    const answers = [
      { status: 'ok' as const, content: 'a red square', usage: undefined } as any,
    ];
    const judgeMessages = buildJudgeMessages(original, answers, true);
    const hasImage = judgeMessages.some((m) =>
      Array.isArray(m.content) && m.content.some((b: any) => b?.type === 'image_url' || b?.type === 'image'),
    );
    expect(hasImage).toBe(false);
  });

  it('keeps image blocks by default (no strip flag)', async () => {
    const { buildJudgeMessages } = await import('../../services/fusion.js');
    const original = [
      { role: 'user' as const, content: [
        { type: 'text', text: 'what is in this image?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ] },
    ];
    const answers = [
      { status: 'ok' as const, content: 'a red square', usage: undefined } as any,
    ];
    const judgeMessages = buildJudgeMessages(original, answers);
    const hasImage = judgeMessages.some((m) =>
      Array.isArray(m.content) && m.content.some((b: any) => b?.type === 'image_url' || b?.type === 'image'),
    );
    expect(hasImage).toBe(true);
  });
});
