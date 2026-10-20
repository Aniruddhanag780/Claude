import crypto from 'crypto';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { timingSafeStringEqual } from '../routes/proxy.js';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface UrlTokenRow {
  id: number;
  label: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export async function listUrlTokens(): Promise<UrlTokenRow[]> {
  const rows = await getDb().all(`
    SELECT id, label, token_prefix, created_at, last_used_at, revoked_at
    FROM url_tokens
    ORDER BY id DESC
  `) as Array<{
    id: number;
    label: string;
    token_prefix: string;
    created_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
  }>;
  return rows.map(row => ({
    id: row.id,
    label: row.label,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }));
}

export async function mintUrlToken(label: string): Promise<UrlTokenRow & { token: string }> {
  const token = `flmurl_${crypto.randomBytes(24).toString('base64url')}`;
  const prefix = `${token.slice(0, 12)}…`;
  const result = await getDb().run(`
    INSERT INTO url_tokens (token_hash, label, token_prefix)
    VALUES (?, ?, ?) RETURNING id
  `, [hashToken(token), label.trim(), prefix]);
  const row = await (await listUrlTokens()).find(entry => entry.id === Number(result.lastInsertRowid))!;
  return { ...row, token };
}

export async function revokeUrlToken(id: number): Promise<boolean> {
  return await (await getDb().run(`
    UPDATE url_tokens SET revoked_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ? AND revoked_at IS NULL
  `, [id])).changes > 0;
}

export async function validateUrlToken(token: string): Promise<boolean> {
  if (!token || timingSafeStringEqual(token, await getUnifiedApiKey())) {
    if (token) {
      console.warn('[URL tokens] Rejected a raw unified API key in a tokenized URL');
    }
    return false;
  }
  const hash = hashToken(token);
  const row = await getDb().get(`
    SELECT id FROM url_tokens
    WHERE token_hash = ? AND revoked_at IS NULL
  `, [hash]) as { id: number } | undefined;
  if (!row) return false;
  await getDb().run("UPDATE url_tokens SET last_used_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') WHERE id = ?", [row.id]);
  return true;
}
