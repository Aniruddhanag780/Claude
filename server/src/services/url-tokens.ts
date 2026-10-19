import crypto from 'crypto';
import { getUnifiedApiKey, query } from '../db/index.js';
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
  const res = await query(
    `SELECT id, label, token_prefix, created_at, last_used_at, revoked_at
     FROM url_tokens
     ORDER BY id DESC`,
  );
  return res.rows.map(row => ({
    id: Number(row.id),
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
  const res = await query(
    `INSERT INTO url_tokens (token_hash, label, token_prefix)
     VALUES ($1, $2, $3)
     RETURNING id, label, token_prefix, created_at, last_used_at, revoked_at`,
    [hashToken(token), label.trim(), prefix],
  );
  const row = res.rows[0];
  return {
    id: Number(row.id),
    label: row.label,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    token,
  };
}

export async function revokeUrlToken(id: number): Promise<boolean> {
  const res = await query(
    `UPDATE url_tokens SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
  return Number(res.rowCount ?? 0) > 0;
}

export async function validateUrlToken(token: string): Promise<boolean> {
  if (!token || timingSafeStringEqual(token, getUnifiedApiKey())) {
    if (token) {
      console.warn('[URL tokens] Rejected a raw unified API key in a tokenized URL');
    }
    return false;
  }
  const hash = hashToken(token);
  const res = await query(
    `SELECT id FROM url_tokens WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hash],
  );
  const row = res.rows[0] as { id: number } | undefined;
  if (!row) return false;
  await query(`UPDATE url_tokens SET last_used_at = NOW() WHERE id = $1`, [row.id]);
  return true;
}
