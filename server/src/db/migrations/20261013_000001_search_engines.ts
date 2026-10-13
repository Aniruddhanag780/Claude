// Migration: web search engines + search request log (#1174)
// Created: 2026-10-13
//
// DOWN: reversible (drops search_requests; the seeded engine rows stay, see below)
//
// Search engines live in media_models with modality = 'search' and
// model_id = the engine id, maintained by the catalog's `searchEngines`
// registry exactly like video rows. Until a catalog that carries that
// registry has been applied, the four engines below are the bundled
// baseline, so a fresh install can search as soon as a key is added. The
// catalog prunes or re-ranks them once it ships the section.
//
// down() leaves the engine rows in place: they carry AUTOINCREMENT ids, so a
// delete followed by up() would re-create them under new ids, and a leftover
// catalog row on an older binary is inert (nothing older reads modality
// 'search').
//
// search_requests is its own log rather than more `requests` rows: a search
// has no tokens or model, and keeping it out of `requests` keeps the chat
// analytics, success rates and request log free of search traffic.

import type { Db } from '../types.js';

const BASELINE_ENGINES: Array<{
  platform: string;
  engineId: string;
  displayName: string;
  priority: number;
  quotaLabel: string;
  meta: { creditsPerQuery: number | null; features: { news: boolean; answer: boolean; fullContent: boolean } };
}> = [
  {
    platform: 'tavily', engineId: 'tavily-search', displayName: 'Tavily Search', priority: 0,
    quotaLabel: '1,000 credits/month, no card',
    meta: { creditsPerQuery: 1, features: { news: true, answer: true, fullContent: false } },
  },
  {
    platform: 'exa', engineId: 'exa-search', displayName: 'Exa Search', priority: 1,
    quotaLabel: '$10/month in credits',
    meta: { creditsPerQuery: null, features: { news: true, answer: false, fullContent: true } },
  },
  {
    platform: 'firecrawl', engineId: 'firecrawl-search', displayName: 'Firecrawl Search', priority: 2,
    quotaLabel: '1,000 credits/month, no card',
    meta: { creditsPerQuery: 2, features: { news: true, answer: false, fullContent: true } },
  },
  {
    platform: 'linkup', engineId: 'linkup-search', displayName: 'Linkup Search', priority: 3,
    quotaLabel: '€5/month in credits',
    meta: { creditsPerQuery: 1, features: { news: false, answer: true, fullContent: false } },
  },
];

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      engine_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      key_id INTEGER,
      status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
      latency_ms INTEGER NOT NULL DEFAULT 0,
      result_count INTEGER NOT NULL DEFAULT 0,
      client_agent TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_search_requests_created_at ON search_requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_search_requests_engine_created ON search_requests(engine_id, created_at);
  `);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, meta_json)
    VALUES (?, ?, ?, 'search', ?, 1, ?, ?)
  `);
  // A row that survived an earlier down() can have lost its meta_json (the
  // media_model_meta migration's down drops that column), so refill it.
  const refillMeta = db.prepare(`
    UPDATE media_models SET meta_json = ?
     WHERE platform = ? AND model_id = ? AND modality = 'search' AND meta_json IS NULL
  `);
  for (const e of BASELINE_ENGINES) {
    const meta = JSON.stringify(e.meta);
    insert.run(e.platform, e.engineId, e.displayName, e.priority, e.quotaLabel, meta);
    refillMeta.run(meta, e.platform, e.engineId);
  }
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_search_requests_engine_created;
    DROP INDEX IF EXISTS idx_search_requests_created_at;
    DROP TABLE IF EXISTS search_requests;
  `);
}
