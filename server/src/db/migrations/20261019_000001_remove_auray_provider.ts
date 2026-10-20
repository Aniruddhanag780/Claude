// Migration: remove the Auray provider
// Created: 2026-10-19
//
// DOWN: reversible (the removed rows are kept in settings)
//
// Auray started charging for API access and asked to be removed (#1583). The
// adapter is gone, so these rows can never serve again: remove the keys,
// models, embedding and media rows, model overrides, and the chain and profile
// entries that point at the models. Request history keeps its 'auray' rows;
// that is a record, not config. Same shape as the GitHub Models removal.

import type { Db } from '../types.js';

const PLATFORM = 'auray';
const SETTING_KEY = 'migration_auray_removed_rows';

type Row = Record<string, unknown>;

// Insert order for DOWN: parents before the rows that reference them.
const TABLES = ['api_keys', 'models', 'embedding_models', 'media_models', 'model_overrides', 'fallback_config', 'profile_models'] as const;
type Table = (typeof TABLES)[number];

async function tableExists(db: Db, table: string): Promise<boolean> {
  return await db.get("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ?", [table]) !== undefined;
}

async function selectRows(db: Db, table: Table): Promise<Row[]> {
  if (!await tableExists(db, table)) return [];
  if (table === 'fallback_config' || table === 'profile_models') {
    return await db.all(`
      SELECT * FROM ${table} WHERE model_db_id IN (SELECT id FROM models WHERE platform = ?)
    `, [PLATFORM]) as Row[];
  }
  return await db.all(`SELECT * FROM ${table} WHERE platform = ?`, [PLATFORM]) as Row[];
}

// Encrypted key columns may be BLOBs; JSON keeps them as tagged base64.
function encode(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = Buffer.isBuffer(v) ? { $buffer: v.toString('base64') } : v;
  }
  return out;
}

function decode(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    const tagged = v as { $buffer?: string } | null;
    out[k] = tagged && typeof tagged === 'object' && typeof tagged.$buffer === 'string'
      ? Buffer.from(tagged.$buffer, 'base64')
      : v;
  }
  return out;
}

export async function up(db: Db): Promise<void> {
  const removed: Partial<Record<Table, Row[]>> = {};
  for (const table of TABLES) removed[table] = (await selectRows(db, table)).map(encode);

  // Children first: chain and profile rows reference models(id).
  for (const table of ['fallback_config', 'profile_models'] as const) {
    if (!await tableExists(db, table)) continue;
    await db.run(`
      DELETE FROM ${table} WHERE model_db_id IN (SELECT id FROM models WHERE platform = ?)
    `, [PLATFORM]);
  }
  for (const table of ['models', 'embedding_models', 'media_models', 'model_overrides', 'api_keys'] as const) {
    if (!await tableExists(db, table)) continue;
    await db.run(`DELETE FROM ${table} WHERE platform = ?`, [PLATFORM]);
  }

  await db.run(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `, [SETTING_KEY, JSON.stringify(removed)]);
}

export async function down(db: Db): Promise<void> {
  const row = await db.get('SELECT value FROM settings WHERE key = ?', [SETTING_KEY]) as { value: string } | undefined;
  const removed: Partial<Record<Table, Row[]>> = row ? JSON.parse(row.value) : {};
  for (const table of TABLES) {
    for (const raw of removed[table] ?? []) {
      const r = decode(raw);
      const cols = Object.keys(r);
      await db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`, cols.map(c => r[c]));
    }
  }
  await db.run('DELETE FROM settings WHERE key = ?', [SETTING_KEY]);
}
