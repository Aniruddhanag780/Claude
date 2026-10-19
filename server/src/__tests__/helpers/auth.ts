import crypto from 'crypto';
import { getPostgresPool } from '../../db/postgres.js';

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function mintDashboardToken(email = 'test@example.com'): string {
  const token = 'dash-' + crypto.randomBytes(24).toString('hex');
  const tokenHash = sha256(token);
  const pool = getPostgresPool() as any;
  const tables = pool._mockTables as Map<string, any[]> | undefined;
  if (tables) {
    const users = tables.get('users') || [];
    let user = users.find(u => u.email === email);
    if (!user) {
      user = { id: users.length + 1, email, password_hash: 'hash' };
      users.push(user);
      tables.set('users', users);
    }
    const sessions = tables.get('sessions') || [];
    sessions.push({
      id: sessions.length + 1,
      token_hash: tokenHash,
      user_id: user.id,
      expires_at_ms: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    tables.set('sessions', sessions);
  }
  return token;
}

// Gated = under /api/ but not the public bootstrap routes (/api/auth/*, /api/ping).
export function isGatedApiPath(path: string): boolean {
  return path.startsWith('/api/') && !path.startsWith('/api/auth') && path !== '/api/ping';
}
