import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, setSetting, getSetting } from '../../db/index.js';
import { applyCatalog, reapplyCachedCatalog, MIN_CATALOG_VERSION } from '../../services/catalog-sync.js';
import { runMigrations } from '../../db/migrate/runner.js';
import { initTestDb } from '../helpers/test-db.js';
import {
  getCatalogModelTombstone,
  recordCatalogModelTombstone,
  retireCatalogModelUpstream,
  upsertModelOverrides,
} from '../../services/model-state.js';

// applyCatalog is the write path between the published catalog and the live
// router DB. These tests lock its contract: catalog metadata always wins, the
// user's manual disables survive, custom-provider models are untouchable, and
// disappeared models are removed in FK-safe order.

type AnyCatalog = Parameters<typeof applyCatalog>[1];

function baseModel(over: Partial<AnyCatalog['models'][number]> = {}): AnyCatalog['models'][number] {
  return {
    platform: 'groq',
    modelId: 'test-model',
    displayName: 'Test Model',
    intelligenceRank: 10,
    speedRank: 5,
    sizeLabel: 'Medium',
    limits: { rpm: 30, rpd: 1000, tpm: 6000, tpd: null },
    monthlyTokenBudget: '~1M',
    contextWindow: 8192,
    enabled: true,
    supportsVision: false,
    supportsTools: true,
    ...over,
  };
}

function catalogOf(models: AnyCatalog['models'], quirks: AnyCatalog['quirks'] = []): AnyCatalog {
  return {
    version: '2099.01.01',
    generatedAt: new Date().toISOString(),
    tier: 'live',
    models,
    quirks,
  };
}

/** Snapshot every catalog-managed model as catalog entries so applyCatalog keeps them. */
async function existingAsCatalogModels(): Promise<AnyCatalog['models']> {
  const rows = (await getDb().all(`SELECT platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
              rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
              enabled, supports_vision, supports_tools
         FROM models WHERE platform != 'custom' AND key_id IS NULL`)) as Array<Record<string, unknown>>;
  return rows.map((r) =>
    baseModel({
      platform: r.platform as string,
      modelId: r.model_id as string,
      displayName: r.display_name as string,
      intelligenceRank: r.intelligence_rank as number,
      speedRank: r.speed_rank as number,
      sizeLabel: r.size_label as string,
      limits: {
        rpm: r.rpm_limit as number | null,
        rpd: r.rpd_limit as number | null,
        tpm: r.tpm_limit as number | null,
        tpd: r.tpd_limit as number | null,
      },
      monthlyTokenBudget: r.monthly_token_budget as string,
      contextWindow: r.context_window as number | null,
      enabled: (r.enabled as number) === 1,
      supportsVision: (r.supports_vision as number) === 1,
      supportsTools: (r.supports_tools as number) === 1,
    }),
  );
}

type CatalogEmbedding = NonNullable<AnyCatalog['embeddings']>[number];

async function existingAsCatalogEmbeddings(): Promise<CatalogEmbedding[]> {
  const rows = (await getDb().all(`
    SELECT family, platform, model_id, display_name, dimensions,
           max_input_tokens, priority, enabled, quota_label
      FROM embedding_models
     WHERE platform != 'custom' AND key_id IS NULL
  `)) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    family: r.family as string,
    platform: r.platform as string,
    modelId: r.model_id as string,
    displayName: r.display_name as string,
    dimensions: r.dimensions as number,
    maxInputTokens: r.max_input_tokens as number | null,
    priority: r.priority as number,
    enabled: (r.enabled as number) === 1,
    quotaLabel: r.quota_label as string,
  }));
}

describe('applyCatalog', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  it('inserts a new model with a fallback_config row', async () => {
    const models = await existingAsCatalogModels();
    models.push(baseModel({ modelId: 'brand-new-model', displayName: 'Brand New' }));

    const counts = await applyCatalog(getDb(), catalogOf(models));
    expect(counts.inserted).toBe(1);

    const row = (await getDb().get("SELECT id, enabled FROM models WHERE platform = 'groq' AND model_id = 'brand-new-model'")) as { id: number; enabled: number };
    expect(row.enabled).toBe(1);
    const fb = (await getDb().get('SELECT id FROM fallback_config WHERE model_db_id = ?', [row.id]));
    expect(fb).toBeTruthy();
  });

  it('updates metadata in place and respects the enabled policy', async () => {
    const models = await existingAsCatalogModels();
    const target = models.find((m) => m.modelId === 'brand-new-model')!;

    // User disables the model locally; catalog still says enabled -> stays off.
    (await getDb().run("UPDATE models SET enabled = 0 WHERE platform = 'groq' AND model_id = 'brand-new-model'"));
    target.displayName = 'Brand New v2';
    target.limits = { rpm: 99, rpd: null, tpm: null, tpd: null };
    await applyCatalog(getDb(), catalogOf(models));

    let row = (await getDb().get("SELECT display_name, rpm_limit, enabled FROM models WHERE platform = 'groq' AND model_id = 'brand-new-model'")) as { display_name: string; rpm_limit: number; enabled: number };
    expect(row.display_name).toBe('Brand New v2');
    expect(row.rpm_limit).toBe(99);
    expect(row.enabled).toBe(0); // local disable survives

    // Catalog disables (dead upstream) -> force off even if user re-enabled.
    (await getDb().run("UPDATE models SET enabled = 1 WHERE platform = 'groq' AND model_id = 'brand-new-model'"));
    target.enabled = false;
    await applyCatalog(getDb(), catalogOf(models));
    row = (await getDb().get("SELECT display_name, rpm_limit, enabled FROM models WHERE platform = 'groq' AND model_id = 'brand-new-model'")) as typeof row;
    expect(row.enabled).toBe(0);
  });

  it('removes models that left the catalog (and their fallback rows)', async () => {
    const models = (await existingAsCatalogModels()).filter((m) => m.modelId !== 'brand-new-model');
    const before = (await getDb().get("SELECT id FROM models WHERE model_id = 'brand-new-model'")) as { id: number };

    const counts = await applyCatalog(getDb(), catalogOf(models));
    expect(counts.removed).toBe(1);
    expect((await getDb().get("SELECT id FROM models WHERE model_id = 'brand-new-model'"))).toBeUndefined();
    expect((await getDb().get('SELECT id FROM fallback_config WHERE model_db_id = ?', [before.id]))).toBeUndefined();
  });

  it('sweeps rows pinned to keys that no longer exist (#1516)', async () => {
    const db = getDb();
    // 999999 names no api_keys row: exactly the orphan the delete cascade
    // used to leave behind on standard platforms.
    const chat = (await db.run(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, key_id, enabled, source)
      VALUES ('groq', 'orphan-sync-chat-1516', 'Orphan Chat', 50, 50, 'Large', 999999, 1, 'user') RETURNING id`));
    (await db.run('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 9999, 1) RETURNING id', [chat.lastInsertRowid]));
    (await db.run(`
      INSERT INTO embedding_models (family, platform, model_id, display_name, dimensions, priority, enabled, quota_label, key_id)
      VALUES ('fam-sync-1516', 'groq', 'orphan-sync-embed-1516', 'Orphan Embed', 768, 1, 1, 'test', 999999) RETURNING id`));

    const counts = await applyCatalog(db, catalogOf(await existingAsCatalogModels()));
    expect(counts.removed).toBeGreaterThanOrEqual(2);
    expect((await db.get("SELECT id FROM models WHERE model_id = 'orphan-sync-chat-1516'"))).toBeUndefined();
    expect((await db.get('SELECT id FROM fallback_config WHERE model_db_id = ?', [chat.lastInsertRowid]))).toBeUndefined();
    expect((await db.get("SELECT id FROM embedding_models WHERE model_id = 'orphan-sync-embed-1516'"))).toBeUndefined();
  });

  it('never touches custom-provider models', async () => {
    (await getDb().run(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
         VALUES ('custom', 'my-local-model', 'My Local', 50, 50, 'Custom', 1) RETURNING id`));

    // Catalog without the custom model: it must survive the delete pass.
    await applyCatalog(getDb(), catalogOf((await existingAsCatalogModels()).filter((m) => m.platform !== 'custom')));
    const row = (await getDb().get("SELECT enabled FROM models WHERE platform = 'custom'")) as { enabled: number };
    expect(row.enabled).toBe(1);
  });

  it('re-applies local model overrides after catalog metadata refreshes', async () => {
    const models = (await existingAsCatalogModels()).filter((m) => m.modelId !== 'override-model');
    models.push(baseModel({
      modelId: 'override-model',
      displayName: 'Catalog Name',
      contextWindow: 1000,
      supportsTools: false,
    }));
    await applyCatalog(getDb(), catalogOf(models));

    await upsertModelOverrides(getDb(), 'groq', 'override-model', {
      displayName: 'Local Name',
      contextWindow: 12345,
      supportsTools: true,
    });

    const refreshed = (await existingAsCatalogModels()).filter((m) => m.modelId !== 'override-model');
    refreshed.push(baseModel({
      modelId: 'override-model',
      displayName: 'Catalog Name v2',
      contextWindow: 2000,
      supportsTools: false,
    }));
    await applyCatalog(getDb(), catalogOf(refreshed));

    const row = (await getDb().get(`
      SELECT display_name, context_window, supports_tools
        FROM models
       WHERE platform = 'groq' AND model_id = 'override-model'
    `)) as { display_name: string; context_window: number; supports_tools: number };
    expect(row).toEqual({ display_name: 'Local Name', context_window: 12345, supports_tools: 1 });
  });

  it('keeps user-deleted catalog models deleted across catalog refreshes', async () => {
    const models = (await existingAsCatalogModels()).filter((m) => m.modelId !== 'tombstone-model');
    models.push(baseModel({ modelId: 'tombstone-model', displayName: 'Tombstone Me' }));
    await applyCatalog(getDb(), catalogOf(models));
    expect((await getDb().get("SELECT id FROM models WHERE platform = 'groq' AND model_id = 'tombstone-model'"))).toBeDefined();

    await recordCatalogModelTombstone(getDb(), 'chat', 'groq', 'tombstone-model');
    await applyCatalog(getDb(), catalogOf(models));
    expect((await getDb().get("SELECT id FROM models WHERE platform = 'groq' AND model_id = 'tombstone-model'"))).toBeUndefined();

    await applyCatalog(getDb(), catalogOf(models));
    expect((await getDb().get("SELECT id FROM models WHERE platform = 'groq' AND model_id = 'tombstone-model'"))).toBeUndefined();
  });

  it('skips models for platforms this binary has no provider for', async () => {
    const models = await existingAsCatalogModels();
    models.push(baseModel({ platform: 'some-future-provider', modelId: 'future-model' }));
    const counts = await applyCatalog(getDb(), catalogOf(models));
    expect(counts.skippedUnknownPlatform).toBeGreaterThanOrEqual(1);
    expect((await getDb().get("SELECT id FROM models WHERE platform = 'some-future-provider'"))).toBeUndefined();
  });

  it('skips Auray rows a catalog still carries after the provider was removed (#1583)', async () => {
    const models = await existingAsCatalogModels();
    models.push(baseModel({ platform: 'auray', modelId: 'kimi-k3' }));
    const counts = await applyCatalog(getDb(), catalogOf(models));
    expect(counts.skippedUnknownPlatform).toBeGreaterThanOrEqual(1);
    expect((await getDb().get("SELECT id FROM models WHERE platform = 'auray'"))).toBeUndefined();
  });

  it('imports the new chat providers and keeps Speechify exclusively in audio', async () => {
    const models = await existingAsCatalogModels();
    models.push(baseModel({ platform: 'clod', modelId: 'test-clod' }));
    models.push(baseModel({ platform: 'blaze', modelId: 'test-blaze' }));
    models.push(baseModel({ platform: 'speechify', modelId: 'test-simba', modality: 'audio' }));
    await applyCatalog(getDb(), catalogOf(models));
    for (const platform of ['clod', 'blaze']) {
      expect((await getDb().get('SELECT enabled FROM models WHERE platform = ?', [platform]))).toEqual({ enabled: 1 });
    }
    expect((await getDb().get("SELECT id FROM models WHERE platform = 'speechify'"))).toBeUndefined();
    expect((await getDb().get("SELECT model_id, modality, enabled FROM media_models WHERE platform = 'speechify'"))).toEqual({ model_id: 'test-simba', modality: 'audio', enabled: 1 });
  });

  it('imports Free.ai speech only from the catalog, never as a chat model or bundled seed', async () => {
    expect((await getDb().get("SELECT id FROM media_models WHERE platform='freeai'"))).toBeUndefined();
    const catalog = catalogOf([...await existingAsCatalogModels(), baseModel({ platform: 'freeai', modelId: 'kokoro', modality: 'audio' })]);
    await applyCatalog(getDb(), catalog);
    await applyCatalog(getDb(), catalog);
    expect((await getDb().get("SELECT id FROM models WHERE platform='freeai'"))).toBeUndefined();
    expect((await getDb().all("SELECT model_id, modality, enabled FROM media_models WHERE platform='freeai'"))).toEqual([{ model_id: 'kokoro', modality: 'audio', enabled: 1 }]);
  });

  it('adds Speka chat and embedding rows only when the signed catalog supplies them', async () => {
    expect((await getDb().get("SELECT id FROM models WHERE platform = 'speka'"))).toBeUndefined();
    expect((await getDb().get("SELECT id FROM embedding_models WHERE platform = 'speka'"))).toBeUndefined();
    const catalog = catalogOf([...await existingAsCatalogModels(), baseModel({ platform: 'speka', modelId: 'z-ai/glm-5.3' })]);
    catalog.embeddings = [...await existingAsCatalogEmbeddings(), {
      family: 'nemotron-3-embed-1b-speka', platform: 'speka', modelId: 'nvidia/nemotron-3-embed-1b',
      displayName: 'Nemotron 3 Embed 1B (Speka)', dimensions: 2048, maxInputTokens: 8192,
      priority: 1, enabled: true, quotaLabel: '$1/month shared',
    }];
    await applyCatalog(getDb(), catalog);
    expect((await getDb().get("SELECT enabled FROM models WHERE platform = 'speka'"))).toEqual({ enabled: 1 });
    expect((await getDb().get("SELECT dimensions, enabled FROM embedding_models WHERE platform = 'speka'"))).toEqual({ dimensions: 2048, enabled: 1 });
  });

  it('applies the full embedding snapshot and retires a replaced provider id', async () => {
    const embeddings = await existingAsCatalogEmbeddings();
    const openRouter = embeddings.find(
      (m) => m.platform === 'openrouter' && m.modelId === 'nvidia/llama-nemotron-embed-vl-1b-v2',
    );
    expect(openRouter).toBeDefined();
    openRouter!.modelId = 'nvidia/llama-nemotron-embed-vl-1b-v2:free';
    openRouter!.displayName = 'Nemotron Embed VL 1B (OR free)';
    embeddings.push({
      family: 'sea-lion-e5-embedding-600m',
      platform: 'sealion',
      modelId: 'aisingapore/SEA-LION-E5-Embedding-600M',
      displayName: 'SEA-LION E5 Embedding 600M',
      dimensions: 1024,
      maxInputTokens: 8192,
      priority: 1,
      enabled: true,
      quotaLabel: 'free · 10 rpm',
    });
    const catalog = catalogOf(await existingAsCatalogModels());
    catalog.embeddings = embeddings;

    await applyCatalog(getDb(), catalog);

    expect((await getDb().get(`
      SELECT id FROM embedding_models
       WHERE platform = 'openrouter' AND model_id = 'nvidia/llama-nemotron-embed-vl-1b-v2'
    `))).toBeUndefined();
    expect((await getDb().get(`
      SELECT id FROM embedding_models
       WHERE platform = 'openrouter' AND model_id = 'nvidia/llama-nemotron-embed-vl-1b-v2:free'
    `))).toBeDefined();
    expect((await getDb().get(`
      SELECT dimensions FROM embedding_models
       WHERE platform = 'sealion' AND model_id = 'aisingapore/SEA-LION-E5-Embedding-600M'
    `))).toEqual({ dimensions: 1024 });
  });

  it('replaces quirks wholesale', async () => {
    const quirks: AnyCatalog['quirks'] = [
      {
        slug: 'fresh-quirk',
        title: 'Fresh quirk',
        body: 'New knowledge from the catalog.',
        severity: 'warning',
        targets: [{ platform: 'groq', modelGlob: null }],
      },
    ];
    const counts = await applyCatalog(getDb(), catalogOf(await existingAsCatalogModels(), quirks));
    expect(counts.quirks).toBe(1);

    const all = (await getDb().all('SELECT slug FROM quirks')) as { slug: string }[];
    expect(all.map((q) => q.slug)).toEqual(['fresh-quirk']);
    const targets = (await getDb().all('SELECT platform, model_glob FROM quirk_targets'));
    expect(targets).toEqual([{ platform: 'groq', model_glob: null }]);
  });
});

// reapplyCachedCatalog keeps the catalog authoritative across restarts:
// migrations re-assert the bundled baseline on every boot (INSERT OR IGNORE
// re-adds catalog-deleted models, family rules reset flags) while the boot
// sync 304s on an unchanged version. The cached re-apply closes that gap.
describe('reapplyCachedCatalog', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  async function cacheCatalog(catalog: AnyCatalog) {
    await setSetting('catalog_applied_version', catalog.version);
    await setSetting('catalog_applied_tier', catalog.tier);
    await setSetting('catalog_applied_json', JSON.stringify(catalog));
  }

  it('restores catalog state over a re-run of the baseline migrations', async () => {
    // Catalog says: one baseline model is gone. The victim must be one that a
    // re-runnable migration re-inserts on boot (V23's INSERT OR IGNORE rows),
    // not a first-init-only seed row — that re-insertion is the exact drift
    // this function exists to undo.
    const models = await existingAsCatalogModels();
    const victim = models.find((m) => m.platform === 'openrouter' && m.modelId === 'moonshotai/kimi-k2.6:free')!;
    expect(victim).toBeDefined();
    const remaining = models.filter((m) => m.modelId !== victim.modelId);
    const catalog = catalogOf(remaining);
    await applyCatalog(getDb(), catalog);
    await cacheCatalog(catalog);
    expect(
      (await getDb().get('SELECT id FROM models WHERE platform = ? AND model_id = ?', [victim.platform, victim.modelId])),
    ).toBeUndefined();

    // Simulate a restart: re-run the baseline migrations so their
    // INSERT OR IGNORE re-adds the catalog-deleted model. The source-provenance
    // migration (20260726_000003) must stay recorded as applied — in the real
    // timeline its backfill runs exactly once (every install with an applied
    // catalog cache already has a migrations table), and re-running it here
    // would re-classify the baseline's re-inserted rows against the applied
    // catalog instead of leaving them catalog-owned.
    (await getDb().run("DELETE FROM migrations WHERE filename NOT LIKE '20260726_000003%'"));
    await runMigrations(getDb(), 'up');
    expect(
      (await getDb().get('SELECT id FROM models WHERE platform = ? AND model_id = ?', [victim.platform, victim.modelId])),
    ).toBeDefined();

    // Boot re-apply removes it again from the local cache, no network.
    const result = await reapplyCachedCatalog();
    expect(result.reapplied).toBe(true);
    expect(result.version).toBe(catalog.version);
    expect(
      (await getDb().get('SELECT id FROM models WHERE platform = ? AND model_id = ?', [victim.platform, victim.modelId])),
    ).toBeUndefined();
  });

  it('keeps an upstream retirement across a cached re-apply, and lifts it only for a newer catalog', async () => {
    // The re-apply replays the snapshot the retirement already post-dates, so
    // it must not read that snapshot as a newer opinion — otherwise every 410
    // (#634) is undone by the next restart. A genuinely newer catalog still
    // wins, which is what the lift exists for.
    const models = await existingAsCatalogModels();
    models.push(baseModel({ modelId: 'replay-retired', displayName: 'Replay Retired' }));
    const catalog = catalogOf(models);
    await applyCatalog(getDb(), catalog);
    await cacheCatalog(catalog);

    const row = (await getDb().get("SELECT id FROM models WHERE platform = 'groq' AND model_id = 'replay-retired'")) as { id: number };
    expect(await retireCatalogModelUpstream(getDb(), row.id, 'groq', 'replay-retired', 'HTTP 410 gone')).toBe(true);
    const chainOff = async () =>
      ((await getDb().get('SELECT enabled FROM fallback_config WHERE model_db_id = ?', [row.id])) as { enabled: number }).enabled;
    expect(await chainOff()).toBe(0);

    expect((await reapplyCachedCatalog()).reapplied).toBe(true);
    expect((await getCatalogModelTombstone(getDb(), 'chat', 'groq', 'replay-retired'))?.source).toBe('upstream_eol');
    expect(await chainOff()).toBe(0);
    // Retirement disables the chain entries, never the row: the dashboard keeps
    // showing it as retired upstream rather than losing it.
    expect(
      ((await getDb().get('SELECT enabled FROM models WHERE id = ?', [row.id])) as { enabled: number }).enabled,
    ).toBe(1);

    // Same model, still listed enabled, but a catalog the install has not seen.
    const newer = catalogOf(await existingAsCatalogModels());
    newer.version = '2099.02.02';
    await applyCatalog(getDb(), newer);
    expect(await getCatalogModelTombstone(getDb(), 'chat', 'groq', 'replay-retired')).toBeUndefined();
    expect(await chainOff()).toBe(1);
  });

  it('clears the applied version when an older install has no cached document', async () => {
    (await getDb().run("DELETE FROM settings WHERE key = 'catalog_applied_json'"));
    await setSetting('catalog_applied_version', '2099.01.01');
    const result = await reapplyCachedCatalog();
    expect(result.reapplied).toBe(false);
    expect(await getSetting('catalog_applied_version')).toBeUndefined();
  });

  it('is a no-op without throwing on a corrupt cache', async () => {
    await setSetting('catalog_applied_json', 'not json at all {');
    expect((await reapplyCachedCatalog()).reapplied).toBe(false);
  });

  it('refuses a cached catalog older than the bundled baseline', async () => {
    const catalog = catalogOf(await existingAsCatalogModels());
    catalog.version = '2000.01.01';
    expect(catalog.version < MIN_CATALOG_VERSION).toBe(true);
    await setSetting('catalog_applied_json', JSON.stringify(catalog));
    expect((await reapplyCachedCatalog()).reapplied).toBe(false);
  });
});

// The speech-to-text registry rides the catalog's dedicated optional
// `transcriptionModels` key (NOT the `models` array — old binaries would
// ingest unknown-modality models entries as chat models) and lands in
// media_models with modality='transcription'. These tests lock the sync,
// prune scoping, enabled-merge, tombstone, and rejection rules.
describe('applyCatalog: transcriptionModels', () => {
  type CatalogTranscription = NonNullable<AnyCatalog['transcriptionModels']>[number];

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  function sttRoster(): CatalogTranscription[] {
    return [
      { platform: 'groq', modelId: 'whisper-large-v3-turbo', displayName: 'Whisper Large v3 Turbo (Groq)', priority: 0, enabled: true, maxBytes: 26214400 },
      { platform: 'groq', modelId: 'whisper-large-v3', displayName: 'Whisper Large v3 (Groq)', priority: 1, enabled: true, maxBytes: 26214400 },
      { platform: 'cloudflare', modelId: '@cf/openai/whisper-large-v3-turbo', displayName: 'Whisper Large v3 Turbo (Cloudflare Workers AI)', priority: 2, enabled: true, subtitleFormats: ['vtt'], requestStyle: 'json' },
      { platform: 'cloudflare', modelId: '@cf/openai/whisper', displayName: 'Whisper (Cloudflare Workers AI)', priority: 3, enabled: true, subtitleFormats: ['vtt'], requestStyle: 'binary' },
    ];
  }

  /** Catalog with an image media model plus (optionally) a STT snapshot. */
  async function sttCatalog(entries?: CatalogTranscription[]): Promise<AnyCatalog> {
    const models = await existingAsCatalogModels();
    models.push(baseModel({
      platform: 'cloudflare',
      modelId: '@cf/test/image-model',
      displayName: 'Test Image Model',
      modality: 'image',
    }));
    const catalog = catalogOf(models);
    if (entries) catalog.transcriptionModels = entries;
    return catalog;
  }

  async function sttRows(): Promise<Array<{ platform: string; model_id: string; enabled: number; priority: number; meta_json: string | null }>> {
    return (await getDb().all(`
      SELECT platform, model_id, enabled, priority, meta_json
        FROM media_models
       WHERE modality = 'transcription'
       ORDER BY priority, id
    `)) as any;
  }

  it('routes entries into media_models with modality, meta_json, and priority order', async () => {
    const counts = await applyCatalog(getDb(), await sttCatalog(sttRoster()));
    expect(counts.inserted).toBeGreaterThanOrEqual(5); // 4 STT + the image row

    const rows = await sttRows();
    expect(rows.map(r => `${r.platform}:${r.model_id}`)).toEqual([
      'groq:whisper-large-v3-turbo',
      'groq:whisper-large-v3',
      'cloudflare:@cf/openai/whisper-large-v3-turbo',
      'cloudflare:@cf/openai/whisper',
    ]);
    expect(JSON.parse(rows[0].meta_json!)).toEqual({ maxBytes: 26214400 });
    expect(JSON.parse(rows[2].meta_json!)).toEqual({ subtitleFormats: ['vtt'], requestStyle: 'json' });
    expect(JSON.parse(rows[3].meta_json!)).toEqual({ subtitleFormats: ['vtt'], requestStyle: 'binary' });

    // The image row landed alongside, in its own modality.
    const image = (await getDb().get("SELECT modality FROM media_models WHERE platform = 'cloudflare' AND model_id = '@cf/test/image-model'")) as { modality: string };
    expect(image.modality).toBe('image');
  });

  it('enabled merge: local disable survives a catalog enable; catalog disable forces off', async () => {
    (await getDb().run("UPDATE media_models SET enabled = 0 WHERE modality = 'transcription' AND model_id = 'whisper-large-v3'"));
    await applyCatalog(getDb(), await sttCatalog(sttRoster())); // catalog still says enabled
    expect((await sttRows()).find(r => r.model_id === 'whisper-large-v3')!.enabled).toBe(0);

    (await getDb().run("UPDATE media_models SET enabled = 1 WHERE modality = 'transcription' AND model_id = 'whisper-large-v3'"));
    const roster = sttRoster();
    roster.find(m => m.modelId === 'whisper-large-v3')!.enabled = false;
    await applyCatalog(getDb(), await sttCatalog(roster));
    expect((await sttRows()).find(r => r.model_id === 'whisper-large-v3')!.enabled).toBe(0);

    // Restore for the following tests.
    await applyCatalog(getDb(), await sttCatalog(sttRoster()));
    (await getDb().run("UPDATE media_models SET enabled = 1 WHERE modality = 'transcription'"));
  });

  it('a catalog without the key leaves existing transcription rows untouched', async () => {
    await applyCatalog(getDb(), await sttCatalog(undefined)); // old payload shape
    expect(await sttRows()).toHaveLength(4);
  });

  it('prunes dropped transcription rows, scoped to the modality', async () => {
    const roster = sttRoster().filter(m => m.modelId !== '@cf/openai/whisper');
    const counts = await applyCatalog(getDb(), await sttCatalog(roster));
    expect(counts.removed).toBe(1);
    expect((await sttRows()).map(r => r.model_id)).not.toContain('@cf/openai/whisper');
    // Image row untouched by the transcription prune.
    expect((await getDb().get("SELECT id FROM media_models WHERE model_id = '@cf/test/image-model'"))).toBeDefined();
  });

  it('skips entries for platforms without a transcription adapter', async () => {
    const roster = sttRoster();
    roster.push({ platform: 'nvidia', modelId: 'parakeet-stt', displayName: 'Parakeet', priority: 9, enabled: true });
    const counts = await applyCatalog(getDb(), await sttCatalog(roster));
    expect(counts.skippedUnknownPlatform).toBeGreaterThanOrEqual(1);
    expect((await sttRows()).map(r => r.model_id)).not.toContain('parakeet-stt');
  });

  it('tombstoned (user-deleted) transcription models stay deleted', async () => {
    await recordCatalogModelTombstone(getDb(), 'media', 'groq', 'whisper-large-v3');
    await applyCatalog(getDb(), await sttCatalog(sttRoster()));
    expect((await sttRows()).map(r => r.model_id)).not.toContain('whisper-large-v3');
  });

  it('a malformed transcriptionModels key rejects the whole payload', async () => {
    const catalog = await sttCatalog(sttRoster());
    (catalog as any).transcriptionModels = [{ platform: 'groq' }]; // missing required fields
    await setSetting('catalog_applied_json', JSON.stringify(catalog));
    // isCatalog gates both the network and the cached re-apply paths.
    expect((await reapplyCachedCatalog()).reapplied).toBe(false);
  });
});

// Video models use a dedicated optional top-level registry. That shape is the
// backward-compatibility boundary: clients released before video support ignore
// it, instead of misclassifying an unknown models[].modality as chat.
describe('applyCatalog: videoModels', () => {
  type CatalogVideo = NonNullable<AnyCatalog['videoModels']>[number];

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  function videoRoster(): CatalogVideo[] {
    return [
      {
        platform: 'pollinations',
        modelId: 'nova-reel',
        displayName: 'Nova Reel',
        priority: 0,
        enabled: true,
        quotaLabel: 'Recurring daily Pollen refill',
      },
      {
        platform: 'huggingface',
        modelId: 'Lightricks/LTX-Video-0.9.5',
        displayName: 'LTX-Video 0.9.5',
        priority: 1,
        enabled: true,
        quotaLabel: '$0.10 shared monthly credits',
        providerModelId: 'fal-ai/ltx-video-v095',
      },
    ];
  }

  async function videoCatalog(entries?: CatalogVideo[]): Promise<AnyCatalog> {
    const catalog = catalogOf(await existingAsCatalogModels());
    if (entries) catalog.videoModels = entries;
    return catalog;
  }

  async function videoRows(): Promise<Array<{ platform: string; model_id: string; enabled: number; priority: number; meta_json: string | null }>> {
    return (await getDb().all(`
      SELECT platform, model_id, enabled, priority, meta_json
        FROM media_models
       WHERE modality = 'video'
       ORDER BY priority, id
    `)) as any;
  }

  it('lands the video roster and provider-native metadata in media_models', async () => {
    const counts = await applyCatalog(getDb(), await videoCatalog(videoRoster()));
    expect(counts.inserted).toBeGreaterThanOrEqual(2);
    expect((await videoRows()).map(r => `${r.platform}:${r.model_id}`)).toEqual([
      'pollinations:nova-reel',
      'huggingface:Lightricks/LTX-Video-0.9.5',
    ]);
    expect((await videoRows())[0].meta_json).toBeNull();
    expect(JSON.parse((await videoRows())[1].meta_json!)).toEqual({ providerModelId: 'fal-ai/ltx-video-v095' });
  });

  it('retains video rows when an older catalog omits the optional registry', async () => {
    await applyCatalog(getDb(), await videoCatalog(undefined));
    expect(await videoRows()).toHaveLength(2);
  });

  it('prunes only video rows when the registry drops a model', async () => {
    const counts = await applyCatalog(
      getDb(),
      await videoCatalog(videoRoster().filter(m => m.platform !== 'pollinations')),
    );
    expect(counts.removed).toBe(1);
    expect((await videoRows()).map(r => r.model_id)).toEqual(['Lightricks/LTX-Video-0.9.5']);
  });

  it('skips a video entry without a runtime adapter', async () => {
    const roster = videoRoster();
    roster.push({
      platform: 'cloudflare',
      modelId: 'future-video',
      displayName: 'Future Video',
      priority: 9,
      enabled: true,
    });
    const counts = await applyCatalog(getDb(), await videoCatalog(roster));
    expect(counts.skippedUnknownPlatform).toBeGreaterThanOrEqual(1);
    expect((await videoRows()).map(r => r.model_id)).not.toContain('future-video');
  });

  it('keeps a user-deleted video model tombstoned', async () => {
    await recordCatalogModelTombstone(getDb(), 'media', 'pollinations', 'nova-reel');
    await applyCatalog(getDb(), await videoCatalog(videoRoster()));
    expect((await videoRows()).map(r => r.model_id)).not.toContain('nova-reel');
  });

  it('rejects malformed video metadata before applying the cached catalog', async () => {
    const catalog = await videoCatalog(videoRoster());
    (catalog.videoModels![0] as any).providerModelId = 42;
    await setSetting('catalog_applied_json', JSON.stringify(catalog));
    expect((await reapplyCachedCatalog()).reapplied).toBe(false);
  });
});

// Generative media rows (image/audio) carry adapter metadata in meta_json the
// same way transcription rows do — the flavour a platform's endpoint expects.
// Cloudflare hosts both JSON-body image models and the FLUX.2 family, whose
// schema takes multipart only, so the flag has to survive the sync.
describe('applyCatalog: generative media meta', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  async function imageCatalog(requestStyle?: string): Promise<AnyCatalog> {
    const models = await existingAsCatalogModels();
    models.push(baseModel({
      platform: 'cloudflare',
      modelId: '@cf/black-forest-labs/flux-2-klein-4b',
      displayName: 'FLUX.2 [klein] 4B',
      modality: 'image',
      ...(requestStyle ? { requestStyle } : {}),
    }));
    models.push(baseModel({
      platform: 'cloudflare',
      modelId: '@cf/black-forest-labs/flux-1-schnell',
      displayName: 'FLUX.1 [schnell]',
      modality: 'image',
    }));
    return catalogOf(models);
  }

  async function metaOf(modelId: string): Promise<string | null> {
    return ((await getDb().get('SELECT meta_json FROM media_models WHERE model_id = ?', [modelId])) as { meta_json: string | null }).meta_json;
  }

  it('carries requestStyle onto an image row, and leaves rows without one NULL', async () => {
    await applyCatalog(getDb(), await imageCatalog('multipart'));
    expect(JSON.parse((await metaOf('@cf/black-forest-labs/flux-2-klein-4b'))!)).toEqual({ requestStyle: 'multipart' });
    expect(await metaOf('@cf/black-forest-labs/flux-1-schnell')).toBeNull();
  });

  it('clears meta when the catalog drops requestStyle (full-snapshot semantics)', async () => {
    await applyCatalog(getDb(), await imageCatalog('multipart'));
    await applyCatalog(getDb(), await imageCatalog());
    expect(await metaOf('@cf/black-forest-labs/flux-2-klein-4b')).toBeNull();
  });

  it('a non-string requestStyle rejects the whole payload', async () => {
    const catalog = await imageCatalog('multipart');
    (catalog.models[catalog.models.length - 2] as any).requestStyle = 42;
    await setSetting('catalog_applied_json', JSON.stringify(catalog));
    expect((await reapplyCachedCatalog()).reapplied).toBe(false);
  });
});

// Web search engines (#1174) ride their own optional registry into
// media_models with modality 'search', on the same rules as video: a catalog
// without the key keeps the bundled baseline, one with it is a full snapshot.
describe('applyCatalog: searchEngines', () => {
  type CatalogSearch = NonNullable<AnyCatalog['searchEngines']>[number];

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  function searchRoster(): CatalogSearch[] {
    return [
      {
        platform: 'exa', engineId: 'exa-search', displayName: 'Exa Search', priority: 0, enabled: true,
        quotaLabel: '$10/month in credits', creditsPerQuery: null,
        features: { news: true, answer: false, fullContent: true },
      },
      {
        platform: 'tavily', engineId: 'tavily-search', displayName: 'Tavily Search', priority: 1, enabled: true,
        quotaLabel: '1,000 credits/month', creditsPerQuery: 1,
        features: { news: true, answer: true }, premiumSince: '2026-10-13T00:00:00.000Z',
      },
    ];
  }

  async function searchCatalog(entries?: CatalogSearch[]): Promise<AnyCatalog> {
    const catalog = catalogOf(await existingAsCatalogModels());
    if (entries) catalog.searchEngines = entries;
    return catalog;
  }

  async function searchRows(): Promise<Array<{ platform: string; model_id: string; enabled: number; priority: number; quota_label: string; meta_json: string | null }>> {
    return (await getDb().all(`
      SELECT platform, model_id, enabled, priority, quota_label, meta_json
        FROM media_models WHERE modality = 'search' ORDER BY priority, id
    `)) as any;
  }

  it('ships no search engines until a catalog carries the registry', async () => {
    expect(await searchRows()).toEqual([]);
  });

  it('applies the registry as a full snapshot with metadata in meta_json', async () => {
    await applyCatalog(getDb(), await searchCatalog(searchRoster()));
    expect((await searchRows()).map(r => `${r.platform}:${r.model_id}`)).toEqual(['exa:exa-search', 'tavily:tavily-search']);
    expect((await searchRows())[0].quota_label).toBe('$10/month in credits');
    expect(JSON.parse((await searchRows())[1].meta_json!)).toEqual({
      creditsPerQuery: 1,
      features: { news: true, answer: true },
      premiumSince: '2026-10-13T00:00:00.000Z',
    });
  });

  it('keeps existing engines when a catalog omits the optional registry', async () => {
    await applyCatalog(getDb(), await searchCatalog(undefined));
    expect(await searchRows()).toHaveLength(2);
  });

  it('removes every engine when the registry is empty (a free catalog before an engine ages in)', async () => {
    const counts = await applyCatalog(getDb(), await searchCatalog([]));
    expect(counts.removed).toBeGreaterThanOrEqual(2);
    expect(await searchRows()).toEqual([]);
    await applyCatalog(getDb(), await searchCatalog(searchRoster()));
    expect(await searchRows()).toHaveLength(2);
  });

  it('keeps a local disable across catalog applies', async () => {
    (await getDb().run("UPDATE media_models SET enabled = 0 WHERE model_id = 'exa-search'"));
    await applyCatalog(getDb(), await searchCatalog(searchRoster()));
    expect((await searchRows()).find(r => r.model_id === 'exa-search')!.enabled).toBe(0);
  });

  it('never prunes a custom search relay', async () => {
    (await getDb().run(`
      INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label)
      VALUES ('custom', 'my-searxng', 'My SearXNG', 'search', 9, 1, 'custom endpoint') RETURNING id`));
    await applyCatalog(getDb(), await searchCatalog(searchRoster()));
    expect((await searchRows()).map(r => r.model_id)).toContain('my-searxng');
  });

  it('skips an engine whose platform has no search adapter in this binary', async () => {
    const roster = searchRoster();
    roster.push({ platform: 'brave', engineId: 'brave-search', displayName: 'Brave', priority: 5, enabled: true });
    const counts = await applyCatalog(getDb(), await searchCatalog(roster));
    expect(counts.skippedUnknownPlatform).toBeGreaterThanOrEqual(1);
    expect((await searchRows()).map(r => r.model_id)).not.toContain('brave-search');
  });

  it('rejects a malformed searchEngines entry before applying the cached catalog', async () => {
    const catalog = await searchCatalog(searchRoster());
    (catalog.searchEngines![0] as any).priority = 'first';
    await setSetting('catalog_applied_json', JSON.stringify(catalog));
    expect((await reapplyCachedCatalog()).reapplied).toBe(false);
  });
});

// Decision models ride their own optional registry into media_models with
// modality 'decision', on the same rules as search engines.
describe('applyCatalog: decisionModels', () => {
  type CatalogDecision = NonNullable<AnyCatalog['decisionModels']>[number];

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    await initTestDb();
  });

  function decisionRoster(): CatalogDecision[] {
    return [
      {
        platform: 'cloudflare', modelId: '@cf/cloudflare/clef-flash', displayName: 'Clef Flash', priority: 0, enabled: true,
        quotaLabel: 'Workers AI free daily neurons', contextWindow: 24576, premiumSince: '2026-09-15T00:00:00.000Z',
      },
      {
        platform: 'openrouter', modelId: 'inception/mercury-decide:free', displayName: 'Mercury Decide (free)', priority: 1, enabled: true,
      },
    ];
  }

  async function decisionCatalog(entries?: CatalogDecision[]): Promise<AnyCatalog> {
    const catalog = catalogOf(await existingAsCatalogModels());
    if (entries) catalog.decisionModels = entries;
    return catalog;
  }

  async function decisionRows(): Promise<Array<{ platform: string; model_id: string; enabled: number; quota_label: string; meta_json: string | null }>> {
    return (await getDb().all(`
      SELECT platform, model_id, enabled, quota_label, meta_json
        FROM media_models WHERE modality = 'decision' ORDER BY priority, id
    `)) as any;
  }

  it('ships no decision models until a catalog carries the registry', async () => {
    expect(await decisionRows()).toEqual([]);
  });

  it('applies the registry as a full snapshot with metadata in meta_json', async () => {
    await applyCatalog(getDb(), await decisionCatalog(decisionRoster()));
    expect((await decisionRows()).map(r => `${r.platform}:${r.model_id}`))
      .toEqual(['cloudflare:@cf/cloudflare/clef-flash', 'openrouter:inception/mercury-decide:free']);
    expect(JSON.parse((await decisionRows())[0].meta_json!)).toEqual({ contextWindow: 24576, premiumSince: '2026-09-15T00:00:00.000Z' });
  });

  it('never adds decision models to the chat models table', async () => {
    const chat = (await getDb().get("SELECT COUNT(*) AS n FROM models WHERE model_id IN ('@cf/cloudflare/clef-flash', 'inception/mercury-decide:free')")) as { n: number };
    expect(chat.n).toBe(0);
  });

  it('keeps existing rows when a catalog omits the registry, prunes on an empty one', async () => {
    await applyCatalog(getDb(), await decisionCatalog(undefined));
    expect(await decisionRows()).toHaveLength(2);
    await applyCatalog(getDb(), await decisionCatalog([]));
    expect(await decisionRows()).toEqual([]);
    await applyCatalog(getDb(), await decisionCatalog(decisionRoster()));
    expect(await decisionRows()).toHaveLength(2);
  });

  it('keeps a local disable across catalog applies', async () => {
    (await getDb().run("UPDATE media_models SET enabled = 0 WHERE model_id = 'inception/mercury-decide:free'"));
    await applyCatalog(getDb(), await decisionCatalog(decisionRoster()));
    expect((await decisionRows()).find(r => r.platform === 'openrouter')!.enabled).toBe(0);
  });

  it('skips a model whose platform has no decision adapter in this binary', async () => {
    const roster = decisionRoster();
    roster.push({ platform: 'groq', modelId: 'some-decider', displayName: 'Nope', priority: 5, enabled: true });
    const counts = await applyCatalog(getDb(), await decisionCatalog(roster));
    expect(counts.skippedUnknownPlatform).toBeGreaterThanOrEqual(1);
    expect((await decisionRows()).map(r => r.model_id)).not.toContain('some-decider');
  });

  it('rejects a malformed decisionModels entry before applying the cached catalog', async () => {
    const catalog = await decisionCatalog(decisionRoster());
    (catalog.decisionModels![0] as any).enabled = 'yes';
    await setSetting('catalog_applied_json', JSON.stringify(catalog));
    expect((await reapplyCachedCatalog()).reapplied).toBe(false);
  });
});
