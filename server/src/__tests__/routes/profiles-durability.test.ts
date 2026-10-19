import { afterEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { closePostgresPool, initDb, getDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';

describe.skipIf(!process.env.USE_REAL_POSTGRES)(
  'profiles (real Postgres durability)',
  () => {
    let app: Express;
    let dashToken: string;

    async function request(
      method: string,
      path: string,
      body?: unknown,
    ) {
      const server = app.listen(0, '127.0.0.1');
      if (!server.listening) {
        await new Promise<void>((resolve) => server.once('listening', resolve));
      }
      const address = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          Authorization: `Bearer ${dashToken}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => null);
      server.close();
      return { status: res.status, body: data };
    }

    beforeEach(async () => {
      const pool = await initDb(':memory:'); // initDb runs migrations on boot
      // Isolate tests: real Postgres persists rows across connections.
      await pool.query('DELETE FROM profile_models');
      await pool.query('DELETE FROM profiles');
      await pool.query("DELETE FROM settings WHERE key = 'active_profile_id'");
      app = createApp();
      const user = await createUser(`durable-${Date.now()}@example.com`, 'password123');
      dashToken = await createSession(user.userId);
    });

    afterEach(async () => {
      await closePostgresPool();
    });

    it('creates, lists, updates, reorders, and deletes a profile durably', async () => {
      const created = await request('POST', '/api/profiles', {
        name: 'durable-chain',
        empty: true,
      });
      expect(created.status).toBe(201);
      expect(created.body.name).toBe('durable-chain');
      const profileId = created.body.id;

      const listed = await request('GET', '/api/profiles');
      expect(listed.status).toBe(200);
      expect(listed.body.some((p: { id: number }) => p.id === profileId)).toBe(true);

      // A second profile so the first can be deleted (can't delete the last one).
      const other = await request('POST', '/api/profiles', { name: 'other-chain', empty: true });
      expect(other.status).toBe(201);

      // Reorder: insert models into the chain (writes profile_models).
      const models = await getDb().query(
        'SELECT id FROM models WHERE enabled ORDER BY id LIMIT 3',
      );
      const saved = await request('PUT', `/api/profiles/${profileId}/reorder`, models.rows.map((m: any, i: number) => ({
        modelDbId: m.id,
        priority: i + 1,
        enabled: i < 2,
      })));
      expect(saved.status).toBe(200);

      const chain = await getDb().query(
        'SELECT model_db_id, priority, enabled FROM profile_models WHERE profile_id = $1 ORDER BY priority',
        [profileId],
      );
      expect(chain.rows).toHaveLength(3);
      expect(chain.rows.map((r: any) => r.priority)).toEqual([1, 2, 3]);

      // Read-through the GET /:id/models endpoint.
      const members = await request('GET', `/api/profiles/${profileId}/models`);
      expect(members.status).toBe(200);
      expect(members.body).toHaveLength(3);

      // Delete.
      const removed = await request('DELETE', `/api/profiles/${profileId}`);
      expect(removed.status).toBe(200);
      const gone = await getDb().query('SELECT 1 FROM profiles WHERE id = $1', [profileId]);
      expect(gone.rows).toHaveLength(0);
    });
  },
);
