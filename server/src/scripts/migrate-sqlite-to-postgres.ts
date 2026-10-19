#!/usr/bin/env node
/**
 * migrate-sqlite-to-postgres — one-time migration of an old SQLite
 * `freeapi.db` into the PostgreSQL schema (migrations 001–007).
 *
 * Fail-loud by design: every section whose source table exists is required to
 * succeed. A failure rolls the whole transaction back and leaves
 * `process.exitCode = 1`. The only soft section is `client_profiles`, which is
 * skipped when its source table is absent (older SQLite DBs predate it).
 *
 * The core (`runMigration`) takes an injected SQLite source and Postgres client
 * so it can be unit-tested without better-sqlite3 or a live Postgres daemon.
 *
 * Reconciliation rule (destination wins, reruns are idempotent):
 *   * settings: upserted by key; `encryption_key` is never copied.
 *   * credentials: a source row is skipped when the destination already has a
 *     row with the same (provider_id, credential_name). The destination row is
 *     kept as-is; nothing is overwritten. Two source rows sharing one identity
 *     are ambiguous — only the first is written, the rest are skipped.
 *   * models: upserted by (provider_id, model_id).
 *   * client_profiles: upserted by api_key.
 * After every section, each migrated source entity is verified present in the
 * destination; a mismatch rolls back and fails.
 *
 * Credential decryption:
 *   * Rows that decrypt are re-encrypted under the current ENCRYPTION_KEY.
 *   * Rows that fail to decrypt (wrong/rotated key, corrupt tag, missing
 *     ciphertext fields) are either fatal (default) or, with
 *     --quarantine-undecryptable, inserted with `enabled = false` and reported.
 *     Ciphertext is never logged or included in error messages.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { getPostgresPool, closePostgresPool } from '../db/postgres.js';
import { encrypt, decrypt, initEncryptionKey, isEncryptionKeyInitialized } from '../lib/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SQLITE_PATH = path.resolve(__dirname, '../../../data/freeapi.db');
const runtimeRequire = createRequire(import.meta.url);

export interface SqliteSource {
  tableExists(name: string): boolean;
  all(sql: string): any[];
}

export interface PgQueryClient {
  query<T = any>(text: string, params?: any[]): Promise<{ rows: T[] }>;
}

export interface SectionResult {
  name: string;
  status: 'ok' | 'skipped' | 'failed' | 'quarantined';
  required: boolean;
  sourceRows: number;
  written: number;
  skippedExisting: number;
  detail?: string;
}

export interface QuarantineEntry {
  provider: string;
  label: string;
  reason: string;
}

export interface MigrationReport {
  ok: boolean;
  sections: SectionResult[];
  quarantine: QuarantineEntry[];
  reconciliation: {
    sourceRowsChecked: number;
    missingInDestination: string[];
    orphanedCredentials: number;
  };
  error?: string;
}

class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

function section(
  name: string,
  required: boolean,
  result: Omit<SectionResult, 'name' | 'required'>,
): SectionResult {
  return { name, required, ...result };
}

/**
 * Runs the migration against an injected source/client. Does not touch
 * process.exit; the CLI wrapper decides exit codes from the returned report.
 */
export async function runMigration(
  source: SqliteSource,
  client: PgQueryClient,
  opts: { quarantineUndecryptable?: boolean } = {},
): Promise<MigrationReport> {
  const quarantine: QuarantineEntry[] = [];
  const sections: SectionResult[] = [];
  const quarantineUndecryptable = Boolean(opts.quarantineUndecryptable);
  const expected: { settings: string[]; credentials: string[]; models: string[]; profiles: string[] } = {
    settings: [],
    credentials: [],
    models: [],
    profiles: [],
  };

  try {
    await client.query('BEGIN');

    const providerMap = new Map<string, number>();
    const existingProviders = await client.query('SELECT id, provider_key FROM providers');
    for (const row of existingProviders.rows) providerMap.set(String(row.provider_key), Number(row.id));

    const ensureProvider = async (
      providerKey: string | null | undefined,
      baseUrl: string | null | undefined = null,
    ): Promise<number> => {
      const key = String(providerKey ?? '');
      let id = providerMap.get(key);
      if (id) return id;
      const res = await client.query(
        `INSERT INTO providers (provider_key, display_name, base_url, enabled, priority)
         VALUES ($1, $2, $3, true, 5)
         ON CONFLICT (provider_key) DO UPDATE SET updated_at = NOW()
         RETURNING id`,
        [key, key.toUpperCase(), baseUrl],
      );
      id = Number(res.rows[0].id);
      providerMap.set(key, id);
      return id;
    };

    // --- 1. settings (required) ---
    if (!source.tableExists('settings')) {
      sections.push(section('settings', true, { status: 'skipped', sourceRows: 0, written: 0, skippedExisting: 0, detail: 'source table absent' }));
    } else {
      const settings = source.all('SELECT key, value FROM settings');
      let written = 0;
      for (const row of settings) {
        if (String(row.key) === 'encryption_key') continue; // never copy the local key into the DB
        expected.settings.push(String(row.key));
        await client.query(
          `INSERT INTO settings (key, value, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [String(row.key), String(row.value ?? '')],
        );
        written++;
      }
      sections.push(section('settings', true, { status: 'ok', sourceRows: settings.length, written, skippedExisting: 0 }));
    }

    // --- 2. api_keys -> providers + credentials (required) ---
    if (!source.tableExists('api_keys')) {
      sections.push(section('api_keys', true, { status: 'skipped', sourceRows: 0, written: 0, skippedExisting: 0, detail: 'source table absent' }));
    } else {
      const keys = source.all('SELECT * FROM api_keys');
      const destCreds = await client.query('SELECT provider_id, credential_name FROM credentials');
      const destSet = new Set<string>();
      for (const row of destCreds.rows) destSet.add(`${Number(row.provider_id)}\u0000${String(row.credential_name ?? '')}`);
      const seenThisRun = new Set<string>();
      let written = 0;
      let skipped = 0;
      for (const key of keys) {
        const platform = String(key.platform ?? '');
        const label = String(key.label ?? '');
        const providerId = await ensureProvider(platform, key.base_url ?? null);
        const identity = `${providerId}\u0000${label}`;
        expected.credentials.push(identity);
        // Destination wins: identical (provider, label) already present -> skip.
        // Keeps reruns idempotent; two source rows sharing one identity are
        // ambiguous — only the first is written (ponytail: narrow identity key,
        // widen if operators hit duplicate-label source DBs).
        if (destSet.has(identity) || seenThisRun.has(identity)) {
          skipped++;
          continue;
        }
        seenThisRun.add(identity);

        let encryptedValue = String(key.encrypted_key ?? '');
        let iv = String(key.iv ?? '');
        let authTag = String(key.auth_tag ?? '');
        let enabled = key.enabled !== 0;
        const credentialType = key.keyless ? 'keyless' : 'api_key';

        let modelScope: any = null;
        if (key.model_scope_json) {
          try {
            modelScope = JSON.parse(String(key.model_scope_json));
          } catch (e: any) {
            throw new MigrationError(
              `cannot migrate credential for provider "${platform}" (label "${label}"): model_scope_json is not valid JSON (${e.message}).`,
            );
          }
        }

        if (!key.keyless && (encryptedValue || iv || authTag)) {
          try {
            const plaintext = decrypt(encryptedValue, iv, authTag);
            const recrypted = encrypt(plaintext);
            encryptedValue = recrypted.encrypted;
            iv = recrypted.iv;
            authTag = recrypted.authTag;
          } catch (e: any) {
            if (!quarantineUndecryptable) {
              throw new MigrationError(
                `cannot migrate credential for provider "${platform}" (label "${label}"): ` +
                  `decryption failed with the current ENCRYPTION_KEY (${e.message}). ` +
                  `Fix ENCRYPTION_KEY, or re-run with --quarantine-undecryptable to migrate this credential DISABLED ` +
                  `(ciphertext is never logged).`,
              );
            }
            enabled = false;
            quarantine.push({ provider: platform, label, reason: `decrypt failed with current ENCRYPTION_KEY: ${e.message}` });
          }
        } else if (!key.keyless) {
          if (!quarantineUndecryptable) {
            throw new MigrationError(
              `cannot migrate credential for provider "${platform}" (label "${label}"): ` +
                `missing encrypted_key/iv/auth_tag fields. Re-run with --quarantine-undecryptable to migrate this ` +
                `credential DISABLED (ciphertext is never logged).`,
            );
          }
          enabled = false;
          quarantine.push({ provider: platform, label, reason: 'missing encrypted_key/iv/auth_tag fields' });
        }

        await client.query(
          `INSERT INTO credentials (
             provider_id, credential_name, encrypted_value, iv, auth_tag,
             credential_type, enabled, priority, model_scope
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [providerId, label, encryptedValue, iv, authTag, credentialType, enabled, 0, modelScope === null ? null : JSON.stringify(modelScope)],
        );
        written++;
      }
      sections.push(
        keys.length === 0
          ? section('api_keys', true, { status: 'skipped', sourceRows: 0, written: 0, skippedExisting: 0, detail: 'source table empty' })
          : section('api_keys', true, { status: 'ok', sourceRows: keys.length, written, skippedExisting: skipped }),
      );
    }

    // --- 3. models (required) ---
    if (!source.tableExists('models')) {
      sections.push(section('models', true, { status: 'skipped', sourceRows: 0, written: 0, skippedExisting: 0, detail: 'source table absent' }));
    } else {
      const models = source.all('SELECT * FROM models');
      let written = 0;
      for (const m of models) {
        const providerId = await ensureProvider(String(m.platform ?? ''));
        expected.models.push(`${providerId}\u0000${String(m.model_id ?? '')}`);
        await client.query(
          `INSERT INTO models (
             provider_id, model_id, canonical_name, display_name, enabled,
             context_window, max_output_tokens, supports_streaming, supports_tools,
             supports_vision, supports_structured_output, supports_reasoning, priority
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, true, false, $10)
           ON CONFLICT (provider_id, model_id) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             enabled = EXCLUDED.enabled,
             context_window = EXCLUDED.context_window,
             updated_at = NOW()`,
          [
            providerId,
            m.model_id,
            m.model_id,
            String(m.display_name ?? m.model_id ?? ''),
            m.enabled !== 0,
            m.context_window ?? null,
            null,
            m.supports_tools === 1,
            m.supports_vision === 1,
            m.intelligence_rank ?? 0,
          ],
        );
        written++;
      }
      sections.push(section('models', true, { status: 'ok', sourceRows: models.length, written, skippedExisting: 0 }));
    }

    // --- 4. client_profiles (optional) ---
    if (!source.tableExists('client_profiles')) {
      sections.push(section('client_profiles', false, { status: 'skipped', sourceRows: 0, written: 0, skippedExisting: 0, detail: 'source table absent' }));
    } else {
      try {
        const profiles = source.all('SELECT * FROM client_profiles');
        const destProfiles = await client.query('SELECT api_key FROM client_profiles');
        const destSet = new Set<string>();
        for (const row of destProfiles.rows) destSet.add(String(row.api_key ?? ''));
        const seenThisRun = new Set<string>();
        let written = 0;
        let skipped = 0;
        for (const p of profiles) {
          const identity = String(p.api_key ?? '');
          expected.profiles.push(identity);
          if (destSet.has(identity) || seenThisRun.has(identity)) {
            skipped++;
            continue;
          }
          seenThisRun.add(identity);
          await client.query(
            `INSERT INTO client_profiles (name, api_key, system_prompt, enabled)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (api_key) DO UPDATE SET
               name = EXCLUDED.name,
               system_prompt = EXCLUDED.system_prompt,
               enabled = EXCLUDED.enabled,
               updated_at = NOW()`,
            [String(p.name ?? ''), identity, p.system_prompt ?? null, p.enabled !== 0],
          );
          written++;
        }
        sections.push(section('client_profiles', false, { status: 'ok', sourceRows: profiles.length, written, skippedExisting: skipped }));
      } catch (e: any) {
        // Optional: required work above is preserved, this section is reported.
        sections.push(section('client_profiles', false, { status: 'failed', sourceRows: 0, written: 0, skippedExisting: 0, detail: `optional section failed: ${e?.message ?? e}` }));
      }
    }

    // --- reconciliation: every migrated source entity must exist in destination ---
    const settingsDest = new Set<string>();
    for (const row of (await client.query('SELECT key FROM settings')).rows) settingsDest.add(String(row.key));
    const credDest = new Set<string>();
    for (const row of (await client.query('SELECT provider_id, credential_name FROM credentials')).rows) {
      credDest.add(`${Number(row.provider_id)}\u0000${String(row.credential_name ?? '')}`);
    }
    const modelDest = new Set<string>();
    for (const row of (await client.query('SELECT provider_id, model_id FROM models')).rows) {
      modelDest.add(`${Number(row.provider_id)}\u0000${String(row.model_id ?? '')}`);
    }
    const profileDest = new Set<string>();
    for (const row of (await client.query('SELECT api_key FROM client_profiles')).rows) profileDest.add(String(row.api_key ?? ''));

    const missing: string[] = [];
    for (const k of expected.settings) if (!settingsDest.has(k)) missing.push(`settings:${k}`);
    for (const k of expected.credentials) if (!credDest.has(k)) missing.push(`credentials:${k}`);
    for (const k of expected.models) if (!modelDest.has(k)) missing.push(`models:${k}`);
    for (const k of expected.profiles) if (!profileDest.has(k)) missing.push(`profiles:${k}`);

    if (missing.length > 0) {
      throw new MigrationError(
        `reconciliation failed: ${missing.length} migrated source row(s) not found in destination: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' ...' : ''}`,
      );
    }

    const providerIds = new Set<number>(providerMap.values());
    let orphanedCredentials = 0;
    const orphanRows = await client.query('SELECT provider_id FROM credentials');
    for (const row of orphanRows.rows) if (!providerIds.has(Number(row.provider_id))) orphanedCredentials++;

    const sourceRowsChecked =
      expected.settings.length + expected.credentials.length + expected.models.length + expected.profiles.length;

    await client.query('COMMIT');

    return {
      ok: sections.every((s) => s.status !== 'failed'),
      sections,
      quarantine,
      reconciliation: {
        sourceRowsChecked,
        missingInDestination: missing,
        orphanedCredentials,
      },
    };
  } catch (err: any) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // best effort; connection may already be dead
    }
    return {
      ok: false,
      sections,
      quarantine,
      reconciliation: { sourceRowsChecked: 0, missingInDestination: [], orphanedCredentials: 0 },
      error: err instanceof MigrationError ? err.message : String(err?.message ?? err),
    };
  }
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function formatReport(report: MigrationReport): string {
  const lines: string[] = [];
  lines.push('[migration] Sections:');
  for (const s of report.sections) {
    lines.push(
      `  - ${s.name} (${s.required ? 'required' : 'optional'}): ${s.status} — source ${s.sourceRows}, written ${s.written}, skipped-existing ${s.skippedExisting}` +
        (s.detail ? ` (${s.detail})` : ''),
    );
  }
  if (report.quarantine.length > 0) {
    lines.push('[migration] Quarantined (migrated DISABLED, ciphertext never logged):');
    for (const q of report.quarantine) {
      lines.push(`    provider=${q.provider} label=${q.label} reason=${q.reason}`);
    }
  }
  const r = report.reconciliation;
  lines.push(
    `[migration] Reconciliation: checked ${r.sourceRowsChecked} source row(s), ` +
      `missing in destination ${r.missingInDestination.length}, orphaned credentials ${r.orphanedCredentials}`,
  );
  if (report.ok) {
    lines.push('[migration] SQLite -> PostgreSQL Migration Complete!');
  } else {
    lines.push(`[migration] Migration FAILED; all changes rolled back.${report.error ? ' ' + report.error : ''}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const sqlitePath = process.env.FREEAPI_DB_PATH?.trim() || DEFAULT_SQLITE_PATH;

  if (!fs.existsSync(sqlitePath)) {
    console.log(`[migration] No SQLite database found at ${sqlitePath}. Nothing to migrate.`);
    return;
  }

  let sqliteDb: any;
  try {
    // better-sqlite3 is a deliberate, optional runtime dependency of this
    // migration script only (it is not part of the server runtime graph).
    const BetterSqlite = runtimeRequire('better-sqlite3');
    sqliteDb = new BetterSqlite(sqlitePath);
  } catch {
    console.error(
      '[migration] better-sqlite3 is required to read an existing SQLite database but it is not installed. ' +
        'Install it (e.g. `npm i -D better-sqlite3`) and re-run, or remove the SQLite file if there is nothing to migrate.',
    );
    process.exitCode = 1;
    return;
  }

  if (!isEncryptionKeyInitialized()) {
    initEncryptionKey();
  }

  const pool = getPostgresPool();
  const client = await pool.connect();
  const source: SqliteSource = {
    tableExists: (name) =>
      !!sqliteDb.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name),
    all: (sql) => sqliteDb.prepare(sql).all(),
  };

  try {
    const report = await runMigration(source, client, { quarantineUndecryptable: flag('quarantine-undecryptable') });
    console.log(formatReport(report));
    if (!report.ok) {
      process.exitCode = 1;
    }
  } finally {
    client.release();
    sqliteDb.close();
    await closePostgresPool();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    console.error('[migration] Fatal error:', err?.message ?? err);
    process.exit(1);
  });
}
