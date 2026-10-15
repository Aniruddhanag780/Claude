import { getPostgresPool } from '../db/postgres.js';

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

export function overriddenFieldNames(overridesJson: string | null | undefined): Array<keyof ModelOverridePatch> {
  const stored = parseOverrides(overridesJson ?? undefined);
  return (Object.keys(stored) as Array<keyof ModelOverridePatch>).filter(key => key in OVERRIDE_COLUMNS);
}

export function routableContextWindow(platform: string, modelId: string, contextWindow: number | null): number | null {
  if (platform === 'github' && modelId === 'openai/gpt-4.1') return 8000;
  return contextWindow;
}

export function refreshModelOverrideBaselines(_db: any, _platform: string, _modelId: string): void {
  // Model overrides are not stored in PostgreSQL schema
}

export function isCatalogManagedModel(row: { platform: string; key_id?: number | null; source?: string }): boolean {
  // `source` is the authoritative provenance (models.source: 'catalog', 'user'
  // or 'discovered'). Discovered rows on built-in platforms (#1348) count as
  // catalog-managed: deleting one records a catalog tombstone, which both
  // discovery and a later catalog honor;
  // callers that select it get an exact answer. The platform/key_id fallback
  // covers callers that don't have the column in hand.
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
  try {
    const pool = getPostgresPool();
    void pool.query('UPDATE models SET enabled = false WHERE id = $1', [modelDbId]);
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
  _db: any,
  _platform: string,
  _modelId: string,
  _patch: ModelOverridePatch
): StoredOverrides {
  return {};
}

export function getModelOverrides(
  _db: any,
  _platform: string,
  _modelId: string
): StoredOverrides {
  return {};
}

export function modelsWithOverriddenField(
  _db: any,
  _field: keyof ModelOverridePatch
): Set<string> {
  return new Set();
}

export function applyModelOverrides(
  _db: any,
  _platform: string,
  _modelId: string
): boolean {
  return false;
}

export function applyAllModelOverrides(_db: any): number {
  return 0;
}

export function deleteTombstonedCatalogModels(_db: any): number {
  return 0;
}
