import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { hashPassword, verifyPassword } from '../lib/password.js';

// Dashboard authentication: email + password accounts with opaque session
// tokens. Distinct from the unified API key, which authenticates the /v1 proxy
// for apps — this gates the /api/* admin surface for the human operator (#35).

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionUser {
  userId: number;
  email: string;
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** The one spelling of an address the DB is keyed on. Exported so callers that
 *  bucket by email (the login throttle in routes/auth.ts) key on exactly what
 *  verifyCredentials will look up — keying on anything else lets a padded
 *  address authenticate against the real row while landing in its own bucket. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function userCount(): number {
  const row = getDb().get('SELECT COUNT(*) AS c FROM users') as { c: number };
  return row.c;
}

/** Create a user. Throws { code: 'email_taken' } if the email already exists. */
export function createUser(email: string, password: string): SessionUser {
  const db = getDb();
  const normalized = normalizeEmail(email);
  const existing = db.get('SELECT id FROM users WHERE email = ?', [normalized]);
  if (existing) {
    const err = new Error('An account with that email already exists') as any;
    err.code = 'email_taken';
    throw err;
  }
  const result = db.run('INSERT INTO users (email, password_hash) VALUES (?, ?) RETURNING id', [normalized, hashPassword(password)]);
  return { userId: Number(result.lastInsertRowid), email: normalized };
}

/** Verify credentials. Returns the user on success, null on failure. */
export function verifyCredentials(email: string, password: string): SessionUser | null {
  const db = getDb();
  const row = db.get('SELECT id, email, password_hash FROM users WHERE email = ?', [normalizeEmail(email)]) as { id: number; email: string; password_hash: string } | undefined;
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return { userId: row.id, email: row.email };
}

/** Desktop app only: a session for the install's account, creating the hidden
 *  machine account (`desktop@localhost`, random password nobody knows) on first
 *  run. The desktop window gets this over IPC; a browser tab on the same
 *  machine gets it from POST /api/auth/desktop-session (routes/auth.ts). */
export function desktopSessionToken(): string {
  if (userCount() === 0) {
    createUser('desktop@localhost', crypto.randomBytes(24).toString('hex'));
  }
  const first = getDb().get('SELECT id FROM users ORDER BY id ASC LIMIT 1') as { id: number };
  return createSession(first.id);
}

/** Mint a session and return the raw token (only the hash is persisted). */
export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  getDb().run('INSERT INTO sessions (token_hash, user_id, expires_at_ms) VALUES (?, ?, ?)', [sha256(token), userId, Date.now() + SESSION_TTL_MS]);
  return token;
}

/** Resolve a session token to its user, or null if missing/expired. */
export function validateSession(token: string | undefined | null): SessionUser | null {
  if (!token) return null;
  const db = getDb();
  const row = db.get(`
    SELECT s.user_id, s.expires_at_ms, u.email
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `, [sha256(token)]) as { user_id: number; expires_at_ms: number; email: string } | undefined;
  if (!row) return null;
  if (row.expires_at_ms < Date.now()) {
    db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
    return null;
  }
  return { userId: row.user_id, email: row.email };
}

export function deleteSession(token: string | undefined | null): void {
  if (!token) return;
  getDb().run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
}

/** Update the email of the authenticated user after verifying the current password. Throws { code: 'email_taken' } on conflict. */
export function updateEmail(userId: number, currentPassword: string, newEmail: string): boolean {
  const db = getDb();
  const row = db.get('SELECT password_hash FROM users WHERE id = ?', [userId]) as { password_hash: string } | undefined;
  if (!row) return false;
  if (!verifyPassword(currentPassword, row.password_hash)) return false;

  const normalized = normalizeEmail(newEmail);
  const existing = db.get('SELECT id FROM users WHERE email = ? AND id != ?', [normalized, userId]);
  if (existing) {
    const err = new Error('An account with that email already exists') as any;
    err.code = 'email_taken';
    throw err;
  }
  db.run('UPDATE users SET email = ? WHERE id = ?', [normalized, userId]);
  // Keep sessions alive; the new email will be reflected on the next validateSession call.
  return true;
}

/** Update the password of the authenticated user after verifying the current one. Invalidates all sessions on success. */
export function updatePassword(userId: number, currentPassword: string, newPassword: string): boolean {
  const db = getDb();
  const row = db.get('SELECT password_hash FROM users WHERE id = ?', [userId]) as { password_hash: string } | undefined;
  if (!row) return false;
  if (!verifyPassword(currentPassword, row.password_hash)) return false;
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), userId]);
  db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  return true;
}

/** The single account's email, or null before first-run setup. */
export function accountEmail(): string | null {
  const row = getDb().get('SELECT email FROM users LIMIT 1') as { email: string } | undefined;
  return row?.email ?? null;
}

/**
 * Reset the password for the single existing user and invalidate all
 * sessions.
 * Returns the user, or null if no user exists.
 */
export function resetUserPassword(newPassword: string): SessionUser | null {
  const db = getDb();
  const row = db.get('SELECT id, email FROM users LIMIT 1') as { id: number; email: string } | undefined;
  if (!row) return null;
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), row.id]);
  db.run('DELETE FROM sessions WHERE user_id = ?', [row.id]);
  return { userId: row.id, email: row.email };
}
