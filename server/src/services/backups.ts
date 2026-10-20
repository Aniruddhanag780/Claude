import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { getDb, getDataDir, getSetting, setSetting } from '../db/index.js';
import type { Db } from '../db/types.js';
import { encryptionKeyFingerprint } from '../lib/crypto.js';
import { restrictDirToOwner, restrictToOwner } from '../lib/file-permissions.js';
import type { Scheduler } from '../lib/scheduler.js';

const SCHEDULE_SETTING = 'backup_schedule';
const LAST_RUN_SETTING = 'backup_last_run_day';

/** Bumped whenever the on-disk dump layout changes in a way an older restore
 *  path would misread. Restore refuses anything it does not know. */
const DUMP_FORMAT = 1;

export const BACKUP_SOURCES = ['manual', 'scheduled', 'pre-restore', 'pre-update'] as const;
export type BackupSource = (typeof BACKUP_SOURCES)[number];

export interface BackupSchedule {
  enabled: boolean;
  /** Local wall-clock time, HH:mm. */
  time: string;
  /** Minimum days between automatic backups. */
  intervalDays: number;
  /** Optional sub-directory of the database directory; '' means <db-dir>/backups. */
  backupPath: string;
}

export interface BackupMeta {
  id: number;
  filename: string;
  filesize: number;
  isFull: boolean;
  source: BackupSource;
  createdAt: string;
  tables: string[];
}

const DEFAULT_SCHEDULE: BackupSchedule = {
  enabled: false,
  time: '03:00',
  intervalDays: 1,
  backupPath: '',
};

function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/* ------------------------------------------------------------------ */
/* Table selection                                                    */
/* ------------------------------------------------------------------ */

// Credentials and live login state. A dump is a file an operator downloads,
// mails to themselves and drops in cloud storage; it must not carry the
// password hashes and session tokens that authenticate the dashboard, and
// restoring one must not resurrect deleted accounts or revoked sessions (or
// log the current operator out mid-restore). `settings` is deliberately NOT
// here: routing strategy, the unified key and the proxy config are exactly
// what an operator expects a backup to bring back.
const EXCLUDED_TABLES = new Set(['users', 'sessions', 'url_tokens']);

/** `backups` is the on-disk backup index itself; dumping and restoring it
 *  would wipe the metadata that tracks the files. `migrations` is the schema
 *  ledger, which restore checks rather than overwrites. */
function isInternalTable(name: string): boolean {
  return name === 'migrations' || name === 'backups' || name.startsWith('sqlite_');
}

export function isExcludedTable(name: string): boolean {
  return EXCLUDED_TABLES.has(name);
}

function isBackupableTable(name: string): boolean {
  return !isInternalTable(name) && !isExcludedTable(name);
}

/** Every table a dump may contain, in a stable order. */
export async function listTables(db: Db = getDb()): Promise<string[]> {
  const rows = await db.all<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  return rows.map((row) => row.table_name).filter(isBackupableTable);
}

/* ------------------------------------------------------------------ */
/* Backup directory (confined to the database directory)              */
/* ------------------------------------------------------------------ */

/** The directory that holds the database file. Dumps live beside the data they
 *  came from — never relative to process.cwd(), which depends on how the server
 *  happened to be launched and can sit anywhere on the disk. */
function dataDir(_db: Db): string {
  return getDataDir();
}

function isInside(root: string, target: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

/** Resolve (and create) the directory a dump is written to. `override` is
 *  interpreted relative to the database directory and may not escape it:
 *  an operator-supplied path is otherwise an arbitrary-write primitive, and
 *  `..`, an absolute path or a symlink out of the tree would all take it
 *  there. Both the lexical path and — once the directory exists — its real
 *  path are checked, so a symlink planted inside the data directory does not
 *  widen the hole. */
export function resolveBackupDir(db: Db, override?: string): string {
  const root = dataDir(db);
  const trimmed = override?.trim() ?? '';
  const dir = trimmed ? path.resolve(root, trimmed) : path.join(root, 'backups');
  if (!isInside(root, dir)) {
    throw httpError(`backupPath must stay inside the database directory (${root})`, 400);
  }

  fs.mkdirSync(dir, { recursive: true });
  restrictDirToOwner(dir);

  try {
    const realRoot = fs.realpathSync(root);
    const realDir = fs.realpathSync(dir);
    if (!isInside(realRoot, realDir)) {
      throw httpError(`backupPath resolves outside the database directory (${realRoot})`, 400);
    }
  } catch (err) {
    if ((err as { status?: number }).status === 400) throw err;
    // realpath is best-effort hardening; the lexical check above already ran.
  }

  return dir;
}

/** Validation hook for the schedule route: reject a path the writer would
 *  refuse later, at the moment the operator types it. */
export function assertBackupPathAllowed(db: Db, backupPath: string): void {
  if (!backupPath.trim()) return;
  resolveBackupDir(db, backupPath);
}

/* ------------------------------------------------------------------ */
/* Schedule                                                           */
/* ------------------------------------------------------------------ */

export async function readBackupSchedule(): Promise<BackupSchedule> {
  const raw = await getSetting(SCHEDULE_SETTING);
  if (!raw) return { ...DEFAULT_SCHEDULE };
  try {
    const parsed = JSON.parse(raw) as Partial<BackupSchedule>;
    return {
      enabled: parsed.enabled === true,
      time: typeof parsed.time === 'string' && /^\d{2}:\d{2}$/.test(parsed.time) ? parsed.time : DEFAULT_SCHEDULE.time,
      intervalDays: typeof parsed.intervalDays === 'number' && parsed.intervalDays >= 1 ? Math.floor(parsed.intervalDays) : DEFAULT_SCHEDULE.intervalDays,
      backupPath: typeof parsed.backupPath === 'string' ? parsed.backupPath : DEFAULT_SCHEDULE.backupPath,
    };
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
}

export async function writeBackupSchedule(schedule: BackupSchedule): Promise<BackupSchedule> {
  await setSetting(SCHEDULE_SETTING, JSON.stringify(schedule));
  return schedule;
}

/* ------------------------------------------------------------------ */
/* Dump header                                                        */
/* ------------------------------------------------------------------ */

/** Identity of the schema a dump was taken against: the number of applied
 *  migrations plus the latest filename. Restoring a dump into a database at a
 *  different schema silently drops columns added since, or fails halfway; the
 *  header lets restore refuse instead. */
export async function schemaVersion(db: Db): Promise<string> {
  const rows = await db.all('SELECT filename FROM migrations ORDER BY filename') as { filename: string }[];
  const latest = rows.length > 0 ? rows[rows.length - 1].filename : '(none)';
  return `${rows.length} migrations, latest ${latest}`;
}

function currentKeyFingerprint(): string {
  return encryptionKeyFingerprint() ?? 'none';
}

interface DumpHeader {
  format: number;
  schema: string;
  keyFingerprint: string;
  tables: string[];
}

async function renderHeader(db: Db, tables: string[], createdAt: string): Promise<string> {
  return [
    '-- freellmapi database backup',
    `-- format: ${DUMP_FORMAT}`,
    `-- created: ${createdAt}`,
    `-- schema: ${await schemaVersion(db)}`,
    `-- key-fingerprint: ${currentKeyFingerprint()}`,
    `-- tables: ${tables.join(', ')}`,
    '-- excluded by policy: ' + [...EXCLUDED_TABLES].join(', '),
    '',
  ].join('\n');
}

function readHeaderField(sql: string, field: string): string | null {
  const match = new RegExp(`^--\\s*${field}:\\s*(.*)$`, 'm').exec(sql);
  return match ? match[1].trim() : null;
}

function parseHeader(sql: string): DumpHeader {
  const format = Number.parseInt(readHeaderField(sql, 'format') ?? '', 10);
  const schema = readHeaderField(sql, 'schema');
  const keyFingerprint = readHeaderField(sql, 'key-fingerprint');
  const tablesLine = readHeaderField(sql, 'tables');
  if (!Number.isInteger(format) || schema === null || keyFingerprint === null) {
    throw httpError('This file is not a freellmapi backup (its header is missing or damaged).', 400);
  }
  return {
    format,
    schema,
    keyFingerprint,
    tables: (tablesLine ?? '').split(',').map((t) => t.trim()).filter((t) => t.length > 0),
  };
}

/* ------------------------------------------------------------------ */
/* SQLite dump                                                        */
/* ------------------------------------------------------------------ */

function sqliteEscape(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  const s = String(value);
  return `'${s.replace(/'/g, "''")}'`;
}

// PostgreSQL has no "show me the CREATE TABLE" catalog entry, and the dump
// only has to carry rows: restore targets a database whose schema the
// migrations already own. The schema is pinned by the dump header instead (the
// migration ledger), which restore checks before replaying anything.
async function createTable(_db: Db, _table: string): Promise<string | null> {
  return null;
}

async function sqliteDumpTable(db: Db, table: string): Promise<string> {
  const columns = (await db.all<{ column_name: string }>(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
    ['public', table],
  )).map((c) => c.column_name);
  const rows = await db.all(`SELECT * FROM "${table}"`) as Record<string, unknown>[];
  const lines: string[] = [`DELETE FROM "${table}";`];
  if (rows.length > 0) {
    const columnList = columns.map((c) => `"${c}"`).join(', ');
    const valueRows = rows.map((row) => `(${columns.map((c) => sqliteEscape(row[c])).join(', ')})`);
    lines.push(`INSERT INTO "${table}" (${columnList}) VALUES\n  ${valueRows.join(',\n  ')};`);
  }
  return lines.join('\n');
}

// No BEGIN/COMMIT in the body: restore runs the whole file inside one
// db.transaction() so a failure halfway through rolls the database back to
// where it started, and a nested BEGIN would abort that.
async function sqliteDump(db: Db, tables: string[], createdAt: string): Promise<string> {
  const lines = [await renderHeader(db, tables, createdAt)];
  for (const table of tables) {
    const create = await createTable(db, table);
    if (create) lines.push(create);
    lines.push(await sqliteDumpTable(db, table));
  }
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* Backup creation                                                    */
/* ------------------------------------------------------------------ */

export async function createBackup(
  db: Db,
  opts: { tables?: string[]; source?: BackupSource; backupPath?: string } = {},
): Promise<BackupMeta> {
  const available = await listTables(db);
  const requested = (opts.tables ?? []).filter((t) => available.includes(t));
  const isFull = requested.length === 0;
  const tables = isFull ? available : requested;

  if (tables.length === 0) {
    throw httpError('No tables to backup', 400);
  }

  const source: BackupSource = opts.source ?? 'manual';
  const now = new Date();
  const createdAt = now.toISOString();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const prefix = source === 'scheduled' ? 'auto-backup' : source === 'manual' ? 'backup' : source;
  const filename = `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex')}.sql`;

  const dir = resolveBackupDir(db, opts.backupPath ?? await (await readBackupSchedule()).backupPath);
  const filepath = path.join(dir, filename);

  fs.writeFileSync(filepath, await sqliteDump(db, tables, createdAt), { encoding: 'utf8', mode: 0o600 });
  restrictToOwner(filepath);

  const filesize = fs.statSync(filepath).size;
  const result = await db.run('INSERT INTO backups (filename, filepath, filesize, is_full, source, created_at, tables_json) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id', [filename, filepath, filesize, isFull ? 1 : 0, source, createdAt, JSON.stringify(tables)]);

  return { id: Number(result.lastInsertRowid), filename, filesize, isFull, source, createdAt, tables };
}

/* ------------------------------------------------------------------ */
/* Backup listing / download / delete / restore                       */
/* ------------------------------------------------------------------ */

interface BackupRow {
  id: number;
  filename: string;
  filepath: string | null;
  filesize: number;
  is_full: number;
  source: string;
  created_at: string;
  tables_json: string;
}

const SELECT_COLUMNS = 'id, filename, filepath, filesize, is_full, source, created_at, tables_json';

function toMeta(row: BackupRow): BackupMeta {
  let tables: string[] = [];
  try {
    const parsed = JSON.parse(row.tables_json) as unknown;
    if (Array.isArray(parsed)) tables = parsed.map(String);
  } catch {
    tables = [];
  }
  const source: BackupSource = (BACKUP_SOURCES as readonly string[]).includes(row.source)
    ? row.source as BackupSource
    : 'manual';
  return {
    id: row.id,
    filename: row.filename,
    filesize: row.filesize,
    isFull: row.is_full === 1,
    source,
    createdAt: row.created_at,
    tables,
  };
}

export async function listBackups(db: Db, opts: { page?: number; pageSize?: number } = {}): Promise<{ items: BackupMeta[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 20));
  const total = (await db.get('SELECT COUNT(*) AS n FROM backups') as { n: number }).n;
  const rows = await db.all(`SELECT ${SELECT_COLUMNS} FROM backups ORDER BY id DESC LIMIT ? OFFSET ?`, [pageSize, (page - 1) * pageSize]) as BackupRow[];
  return { items: rows.map(toMeta), total };
}

async function readBackupRecord(db: Db, id: number): Promise<BackupRow> {
  const row = await db.get(`SELECT ${SELECT_COLUMNS} FROM backups WHERE id = ?`, [id]) as BackupRow | undefined;
  if (!row) throw httpError('Backup not found', 404);
  return row;
}

/** The recorded path, re-checked against the data directory on every read: a
 *  row written before the directory moved (or edited by hand) must not become
 *  a way to read or delete a file elsewhere on the disk. */
async function backupFilePath(db: Db, row: BackupRow): Promise<string> {
  const root = dataDir(db);
  const candidate = row.filepath
    ? path.resolve(row.filepath)
    : path.join(resolveBackupDir(db, await (await readBackupSchedule()).backupPath), row.filename);
  if (!isInside(root, candidate)) {
    throw httpError('Backup file lies outside the database directory', 400);
  }
  return candidate;
}

export async function getBackupFile(db: Db, id: number): Promise<{ path: string; filename: string }> {
  const row = await readBackupRecord(db, id);
  const filePath = await backupFilePath(db, row);
  if (!fs.existsSync(filePath)) {
    throw httpError('Backup file is missing', 404);
  }
  return { path: filePath, filename: row.filename };
}

export async function deleteBackup(db: Db, id: number): Promise<void> {
  const row = await readBackupRecord(db, id);
  const filePath = await backupFilePath(db, row);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Metadata removal below still succeeds; a missing file is not fatal.
  }
  await db.run('DELETE FROM backups WHERE id = ?', [id]);
}

/** Statements naming a table the dump policy excludes. A dump this server
 *  wrote never contains them, so hitting this means the file was edited or
 *  produced elsewhere — and restoring it would overwrite the operator's own
 *  accounts and sessions. */
const EXCLUDED_STATEMENT_RE = new RegExp(
  `\\b(?:INSERT\\s+INTO|DELETE\\s+FROM|UPDATE|DROP\\s+TABLE)\\s+"?(?:${[...EXCLUDED_TABLES].join('|')})"?\\b`,
  'i',
);

export interface RestoreResult {
  backup: BackupMeta;
  /** Dump of the pre-restore state, written before anything was changed. */
  snapshot: BackupMeta;
}

export async function restoreBackup(db: Db, id: number): Promise<RestoreResult> {
  const row = await readBackupRecord(db, id);
  const filePath = await backupFilePath(db, row);
  if (!fs.existsSync(filePath)) {
    throw httpError('Backup file is missing', 404);
  }

  const sql = fs.readFileSync(filePath, 'utf8');
  const header = parseHeader(sql);

  if (header.format !== DUMP_FORMAT) {
    throw httpError(`This backup uses dump format ${header.format}; this server reads format ${DUMP_FORMAT}.`, 409);
  }

  // A dump only carries rows, not the schema evolution around them. Restoring
  // one taken at a different migration state would drop columns added since,
  // or insert into columns that no longer exist.
  const current = await schemaVersion(db);
  if (header.schema !== current) {
    throw httpError(
      `This backup was taken at a different schema version (backup: ${header.schema}; database: ${current}). ` +
      'Restore it into a server running the matching version.',
      409,
    );
  }

  // api_keys rows hold AES-GCM ciphertext keyed by ENCRYPTION_KEY. Restoring a
  // dump written under a different key would load provider keys nothing on this
  // server can decrypt — every request would then fail at send time, with the
  // real cause several layers away.
  const fingerprint = currentKeyFingerprint();
  if (header.keyFingerprint !== fingerprint) {
    throw httpError(
      `This backup was written under a different ENCRYPTION_KEY (backup: ${header.keyFingerprint}; server: ${fingerprint}). ` +
      'The stored provider keys could not be decrypted. Restore it on the server that holds the original key.',
      409,
    );
  }

  const offending = header.tables.find(isExcludedTable);
  if (offending || EXCLUDED_STATEMENT_RE.test(sql)) {
    throw httpError(
      `This backup writes to ${offending ?? 'an account or session table'}, which backups never include. Refusing to restore it.`,
      400,
    );
  }

  // Written before a single row changes, so a restore that turns out to be the
  // wrong file is one restore away from being undone.
  const snapshot = await createBackup(db, { source: 'pre-restore' });

  try {
    // One transaction for the whole file: a bad dump leaves the database
    // exactly as it was.
    await db.transaction(async (tx) => {
      // Replaying historical log rows is not new provider usage. In a full
      // restore the ledger is restored separately; in a partial log restore
      // the existing ledger remains authoritative. The trigger is dropped and
      // recreated inside the same transaction so a failed restore also
      // restores the trigger.
      const hasUsageTrigger = header.tables.includes('requests');
      if (hasUsageTrigger) {
        await tx.exec('DROP TRIGGER IF EXISTS requests_key_monthly_usage ON requests');
      }
      await tx.exec(sql);
      if (hasUsageTrigger) {
        await tx.exec(`
          CREATE OR REPLACE FUNCTION requests_key_monthly_usage_fn()
          RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
          BEGIN
            IF NEW.key_id IS NOT NULL AND NEW.status = 'success'
               AND to_char(NEW.created_at::timestamp, 'YYYY-MM') IS NOT NULL THEN
              INSERT INTO key_monthly_usage (key_id, month, requests, tokens)
              VALUES (NEW.key_id, to_char(NEW.created_at::timestamp, 'YYYY-MM'), 1,
                      GREATEST(0, NEW.input_tokens) + GREATEST(0, NEW.output_tokens))
              ON CONFLICT(key_id, month) DO UPDATE SET
                requests = key_monthly_usage.requests + 1,
                tokens = key_monthly_usage.tokens + EXCLUDED.tokens;
            END IF;
            RETURN NEW;
          END;
          $fn$;
          DROP TRIGGER IF EXISTS requests_key_monthly_usage ON requests;
          CREATE TRIGGER requests_key_monthly_usage
          AFTER INSERT ON requests FOR EACH ROW
          EXECUTE FUNCTION requests_key_monthly_usage_fn();
        `);
      }
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw httpError(
      `Restore failed and was rolled back; the database is unchanged (${reason}). ` +
      `A snapshot of the current data was saved as ${snapshot.filename}.`,
      400,
    );
  }

  return { backup: toMeta(row), snapshot };
}

/* ------------------------------------------------------------------ */
/* Auto-backup scheduler                                              */
/* ------------------------------------------------------------------ */

export async function startBackupScheduler(scheduler: Scheduler): Promise<() => void> {
  let lastRunDay: string | null = await getSetting(LAST_RUN_SETTING) ?? null;

  const tick = async (): Promise<void> => {
    const schedule = await readBackupSchedule();
    if (!schedule.enabled) return;

    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (hhmm < schedule.time) return;

    const today = now.toISOString().slice(0, 10);
    if (lastRunDay === today) return;

    const intervalDays = Math.max(1, schedule.intervalDays);
    if (lastRunDay) {
      const daysSince = Math.floor((Date.parse(today) - Date.parse(lastRunDay)) / 86_400_000);
      if (daysSince < intervalDays) return;
    }

    lastRunDay = today;
    await setSetting(LAST_RUN_SETTING, today);
    try {
      await createBackup(getDb(), { tables: [], source: 'scheduled', backupPath: schedule.backupPath });
    } catch (err) {
      console.error('[backups] scheduled backup failed:', err);
    }
  };

  const stop = scheduler.every(60_000, tick);
  await tick();
  return stop;
}
