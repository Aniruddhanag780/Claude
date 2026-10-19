import type { applyCatalog } from './catalog-sync.js';

export type CatalogModelKind = 'chat' | 'media';

export interface ModelOverridePatch {
  displayName?: string;
  intelligenceRank?: number;
  speedRank?: number;
  sizeLabel?: string;
  rpmLimit?: number | null;
  rpdLimit?: number | null;
  tpmLimit?: number | null;
  tpdLimit?: number | null;
  monthlyTokenBudget?: string;
  contextWindow?: number | null;
  supportsVision?: boolean;
  supportsTools?: boolean;
  enabled?: boolean;
}

type StoredOverrides = Partial<ModelOverridePatch>;

const CATALOG_BASELINE_KEY = 'catalogDefaults';

const OVERRIDE_COLUMNS: Record<keyof ModelOverridePatch, string> = {
  displayName: 'display_name',
  intelligenceRank: 'intelligence_rank',
  speedRank: 'speed_rank',
  sizeLabel: 'size_label',
  rpmLimit: 'rpm_limit',
  rpdLimit: 'rpd_limit',
  tpmLimit: 'tpm_limit',
  tpdLimit: 'tpd_limit',
  monthlyTokenBudget: 'monthly_token_budget',
  contextWindow: 'context_window',
  supportsVision: 'supports_vision',
  supportsTools: 'supports_tools',
  enabled: 'enabled',
};

function parseOverrides(raw: string | undefined): StoredOverrides {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as StoredOverrides) : {};
  } catch {
    return {};
  }
}

function toDbValue(key: keyof ModelOverridePatch, value: unknown): unknown {
  if (key === 'supportsVision' || key === 'supportsTools' || key === 'enabled') return value ? 1 : 0;
  return value;
}

function cleanPatch(patch: ModelOverridePatch): StoredOverrides {
  const cleaned: StoredOverrides = {};
  for (const key of Object.keys(OVERRIDE_COLUMNS) as Array<keyof ModelOverridePatch>) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      cleaned[key] = patch[key] as never;
    }
  }
  return cleaned;
}

function parseOverridesBlob(raw: string | undefined): { overrides: StoredOverrides; baselines: StoredOverrides } {
  const overrides = parseOverrides(raw);
  const rawBaselines = (overrides as Record<string, unknown>)[CATALOG_BASELINE_KEY];
  delete (overrides as Record<string, unknown>)[CATALOG_BASELINE_KEY];
  const baselines: StoredOverrides = {};
  if (rawBaselines && typeof rawBaselines === 'object') {
    for (const key of Object.keys(rawBaselines as Record<string, unknown>) as Array<keyof ModelOverridePatch>) {
      if (key in OVERRIDE_COLUMNS) baselines[key] = (rawBaselines as StoredOverrides)[key] as never;
    }
  }
  return { overrides, baselines };
}

function modelRowValue(row: Record<string, unknown> | undefined, key: keyof ModelOverridePatch): unknown {
  if (!row) return undefined;
  const value = row[OVERRIDE_COLUMNS[key]];
  if (key === 'supportsVision' || key === 'supportsTools' || key === 'enabled') return value === 1;
  return value ?? null;
}

export function overriddenFieldNames(overridesJson: string | null | undefined): Array<keyof ModelOverridePatch> {
  const stored = parseOverrides(overridesJson ?? undefined);
  return (Object.keys(stored) as Array<keyof ModelOverridePatch>).filter(key => key in OVERRIDE_COLUMNS);
}

export function routableContextWindow(platform: string, modelId: string, contextWindow: number | null): number | null {
  if (platform === 'github' && modelId === 'openai/gpt-4.1') return 8000;
  return contextWindow;
}

function cachedCatalogDefaults(db: any, platform: string, modelId: string): StoredOverrides {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'catalog_applied_json'").get() as { value: string } | undefined;
  if (!row) return {};
  try {
    const catalog = JSON.parse(row.value) as { models?: Parameters<typeof applyCatalog>[1]['models'] };
    const model = catalog.models?.find(m => m.platform === platform && m.modelId === modelId && (!m.modality || m.modality === 'text'));
    if (!model?.limits) return {};
    return {
      displayName: model.displayName, intelligenceRank: model.intelligenceRank,
      speedRank: model.speedRank, sizeLabel: model.sizeLabel,
      rpmLimit: model.limits.rpm, rpdLimit: model.limits.rpd,
      tpmLimit: model.limits.tpm, tpdLimit: model.limits.tpd,
      monthlyTokenBudget: model.monthlyTokenBudget ?? '',
      contextWindow: routableContextWindow(platform, modelId, model.contextWindow),
      supportsVision: model.supportsVision, supportsTools: model.supportsTools,
      enabled: model.enabled,
    };
  } catch { return {}; }
}

export function refreshModelOverrideBaselines(db: any, platform: string, modelId: string): void {
  const existing = db.prepare('SELECT overrides_json FROM model_overrides WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { overrides_json: string } | undefined;
  if (!existing) return;
  const { overrides } = parseOverridesBlob(existing.overrides_json);
  const row = db.prepare('SELECT * FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as Record<string, unknown> | undefined;
  const baselines: StoredOverrides = {};
  for (const key of Object.keys(cleanPatch(overrides)) as Array<keyof ModelOverridePatch>) {
    const value = modelRowValue(row, key);
    if (value !== undefined) baselines[key] = value as never;
  }
  db.prepare('UPDATE model_overrides SET overrides_json = ? WHERE platform = ? AND model_id = ?')
    .run(JSON.stringify({ ...overrides, [CATALOG_BASELINE_KEY]: baselines }), platform, modelId);
}

export function isCatalogManagedModel(row: { platform: string; key_id?: number | null; source?: string }): boolean {
  if (row.source === 'user') return false;
  return row.platform !== 'custom' && row.key_id == null;
}

export type CatalogTombstoneSource = 'user' | 'upstream_eol';

export interface CatalogModelTombstone {
  source: CatalogTombstoneSource;
  reason: string | null;
  createdAt: string;
}

export function getCatalogModelTombstone(
  db: any,
  kind: CatalogModelKind,
  platform: string,
  modelId: string,
): CatalogModelTombstone | undefined {
  try {
    const row = db
      .prepare('SELECT source, reason, created_at FROM catalog_model_tombstones WHERE kind = ? AND platform = ? AND model_id = ?')
      .get(kind, platform, modelId) as { source: string; reason: string | null; created_at: string } | undefined;
    if (!row) return undefined;
    return {
      source: row.source === 'upstream_eol' ? 'upstream_eol' : 'user',
      reason: row.reason ?? null,
      createdAt: row.created_at,
    };
  } catch {
    return undefined;
  }
}

export function isCatalogModelTombstoned(
  db: any,
  kind: CatalogModelKind,
  platform: string,
  modelId: string,
): boolean {
  return getCatalogModelTombstone(db, kind, platform, modelId)?.source === 'user';
}

export function recordCatalogModelTombstone(
  db: any,
  kind: CatalogModelKind,
  platform: string,
  modelId: string,
  options: { source?: CatalogTombstoneSource; reason?: string | null } = {},
): void {
  const source: CatalogTombstoneSource = options.source ?? 'user';
  try {
    db.prepare(`
      INSERT INTO catalog_model_tombstones (kind, platform, model_id, source, reason)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(kind, platform, model_id)
      DO UPDATE SET created_at = datetime('now'), source = excluded.source, reason = excluded.reason
    `).run(kind, platform, modelId, source, options.reason ?? null);
    if (kind === 'chat' && source === 'user') {
      db.prepare('DELETE FROM model_overrides WHERE platform = ? AND model_id = ?').run(platform, modelId);
    }
  } catch {}
}

export function retireCatalogModelUpstream(
  db: any,
  modelDbId: number,
  platform: string,
  modelId: string,
  reason: string,
): boolean {
  const existing = getCatalogModelTombstone(db, 'chat', platform, modelId);
  if (existing) return false;
  recordCatalogModelTombstone(db, 'chat', platform, modelId, { source: 'upstream_eol', reason });
  try {
    db.prepare('UPDATE fallback_config SET enabled = 0 WHERE model_db_id = ?').run(modelDbId);
  } catch {}
  try {
    db.prepare('UPDATE profile_models SET enabled = 0 WHERE model_db_id = ?').run(modelDbId);
  } catch {}
  return true;
}

export function reinstateUpstreamRetiredCatalogModel(
  db: any,
  platform: string,
  modelId: string,
): boolean {
  if (getCatalogModelTombstone(db, 'chat', platform, modelId)?.source !== 'upstream_eol') return false;
  clearCatalogModelTombstone(db, 'chat', platform, modelId);
  try {
    const row = db
      .prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
      .get(platform, modelId) as { id: number } | undefined;
    if (row) {
      db.prepare('UPDATE fallback_config SET enabled = 1 WHERE model_db_id = ?').run(row.id);
      db.prepare('UPDATE profile_models SET enabled = 1 WHERE model_db_id = ?').run(row.id);
    }
  } catch {}
  return true;
}

export function clearCatalogModelTombstone(
  db: any,
  kind: CatalogModelKind,
  platform: string,
  modelId: string,
): void {
  try {
    db.prepare('DELETE FROM catalog_model_tombstones WHERE kind = ? AND platform = ? AND model_id = ?')
      .run(kind, platform, modelId);
  } catch {}
}

export function upsertModelOverrides(
  db: any,
  platform: string,
  modelId: string,
  patch: ModelOverridePatch,
  options: { baselineRow?: Record<string, unknown> } = {},
): StoredOverrides {
  const cleaned = cleanPatch(patch);
  if (Object.keys(cleaned).length === 0) return {};
  const existing = db
    .prepare('SELECT overrides_json FROM model_overrides WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { overrides_json: string } | undefined;
  const { overrides: stored, baselines } = parseOverridesBlob(existing?.overrides_json);

  const catalogDefaults = options.baselineRow ? cachedCatalogDefaults(db, platform, modelId) : {};
  const merged: StoredOverrides = { ...stored };
  const mergedBaselines: StoredOverrides = { ...baselines };
  for (const key of Object.keys(cleaned) as Array<keyof ModelOverridePatch>) {
    const next = cleaned[key] as never;
    if (mergedBaselines[key] === undefined && options.baselineRow) {
      const captured = catalogDefaults[key] !== undefined ? catalogDefaults[key]
        : stored[key] === undefined ? modelRowValue(options.baselineRow, key) : undefined;
      if (captured !== undefined) mergedBaselines[key] = captured as never;
    }
    const baseline = mergedBaselines[key];
    if (options.baselineRow && baseline !== undefined && next === baseline) {
      delete merged[key];
      delete mergedBaselines[key];
    } else {
      merged[key] = next;
    }
  }

  if (Object.keys(merged).length === 0) {
    db.prepare('DELETE FROM model_overrides WHERE platform = ? AND model_id = ?').run(platform, modelId);
    return {};
  }
  const blob = { ...merged, [CATALOG_BASELINE_KEY]: mergedBaselines };
  db.prepare(`
    INSERT INTO model_overrides (platform, model_id, overrides_json, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(platform, model_id)
    DO UPDATE SET overrides_json = excluded.overrides_json, updated_at = excluded.updated_at
  `).run(platform, modelId, JSON.stringify(blob));
  return merged;
}

export function getModelOverrides(
  db: any,
  platform: string,
  modelId: string,
): StoredOverrides {
  const row = db
    .prepare('SELECT overrides_json FROM model_overrides WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { overrides_json: string } | undefined;
  return parseOverrides(row?.overrides_json);
}

export function modelsWithOverriddenField(
  db: any,
  field: keyof ModelOverridePatch,
): Set<string> {
  const rows = db.prepare('SELECT platform, model_id, overrides_json FROM model_overrides')
    .all() as { platform: string; model_id: string; overrides_json: string }[];
  const pinned = new Set<string>();
  for (const row of rows) {
    const overrides = parseOverrides(row.overrides_json);
    if (overrides[field] !== undefined) pinned.add(`${row.platform}:${row.model_id}`);
  }
  return pinned;
}

export function applyModelOverrides(
  db: any,
  platform: string,
  modelId: string,
): boolean {
  const overrides = getModelOverrides(db, platform, modelId);
  const keys = (Object.keys(overrides) as Array<keyof ModelOverridePatch>).filter(k => k in OVERRIDE_COLUMNS);
  if (keys.length === 0) return false;

  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const key of keys) {
    assignments.push(`${OVERRIDE_COLUMNS[key]} = ?`);
    values.push(toDbValue(key, overrides[key]));
  }
  values.push(platform, modelId);
  db.prepare(`UPDATE models SET ${assignments.join(', ')} WHERE platform = ? AND model_id = ?`).run(...values);
  return true;
}

export function applyAllModelOverrides(db: any): number {
  const rows = db.prepare('SELECT platform, model_id FROM model_overrides').all() as { platform: string; model_id: string }[];
  let applied = 0;
  for (const row of rows) {
    if (applyModelOverrides(db, row.platform, row.model_id)) applied++;
  }
  return applied;
}

export function deleteTombstonedCatalogModels(db: any): number {
  const chatRows = db.prepare(`
    SELECT m.id, m.platform, m.model_id
      FROM models m
      JOIN catalog_model_tombstones t
        ON t.kind = 'chat' AND t.platform = m.platform AND t.model_id = m.model_id
     WHERE t.source = 'user' AND m.platform != 'custom' AND m.key_id IS NULL AND m.source != 'user'
  `).all() as { id: number; platform: string; model_id: string }[];
  const mediaRows = db.prepare(`
    SELECT mm.id
      FROM media_models mm
      JOIN catalog_model_tombstones t
        ON t.kind = 'media' AND t.platform = mm.platform AND t.model_id = mm.model_id
     WHERE t.source = 'user'
  `).all() as { id: number }[];

  const deleteChatFallback = db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?');
  const deleteChat = db.prepare('DELETE FROM models WHERE id = ?');
  const deleteMedia = db.prepare('DELETE FROM media_models WHERE id = ?');

  for (const row of chatRows) {
    deleteChatFallback.run(row.id);
    deleteChat.run(row.id);
  }
  for (const row of mediaRows) {
    deleteMedia.run(row.id);
  }

  return chatRows.length + mediaRows.length;
}
