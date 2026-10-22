import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initTestDb } from '../helpers/test-db.js';
import { getSetting } from '../../db/index.js';
import { createApp } from '../../app.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const repoRoot = path.resolve(serverRoot, '..');
const tsxBin = fs.existsSync(path.resolve(serverRoot, 'node_modules/.bin/tsx'))
  ? path.resolve(serverRoot, 'node_modules/.bin/tsx')
  : path.resolve(repoRoot, 'node_modules/.bin/tsx');

describe('Production-Grade PostgreSQL Persistence & Durability Verification', () => {
  const testEncryptionKey = 'a'.repeat(64);
  const testKeyName = `durability_test_${Date.now()}`;
  const testValueInitial = `val_initial_${Math.random().toString(36).substring(2)}`;
  const testValueUpdated = `val_updated_${Math.random().toString(36).substring(2)}`;
  let dbUrl = '';

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = testEncryptionKey;
    await initTestDb();
    dbUrl = process.env.DATABASE_URL!;
  });

  const findSqliteFiles = () => {
    const candidates = ['freellmapi.db', 'data/freellmapi.db', 'freellmapi.sqlite', 'test.db'];
    return candidates.filter(f => fs.existsSync(path.join(serverRoot, f)));
  };

  it('persists data across independent operating system process boundaries without SQLite', async () => {
    expect(findSqliteFiles()).toHaveLength(0);

    // 1. Spawn Subprocess 1: Initialize DB, write test key, verify, and exit
    const scriptStep1 = `
      import { initDb, closeDb, setSetting, getSetting } from './src/db/index.ts';
      process.env.DATABASE_URL = ${JSON.stringify(dbUrl)};
      process.env.ENCRYPTION_KEY = ${JSON.stringify(testEncryptionKey)};
      
      async function run() {
        const db = await initDb();
        await setSetting(${JSON.stringify(testKeyName)}, ${JSON.stringify(testValueInitial)});
        const read = await getSetting(${JSON.stringify(testKeyName)});
        if (read !== ${JSON.stringify(testValueInitial)}) {
          console.error('Mismatch in process 1:', read);
          process.exit(1);
        }
        await closeDb();
        console.log('STEP_1_SUCCESS');
      }
      run().catch(err => {
        console.error(err);
        process.exit(1);
      });
    `;

    const out1 = execFileSync(tsxBin, ['-e', scriptStep1], {
      cwd: serverRoot,
      env: {
        ...process.env,
        DATABASE_URL: dbUrl,
        TEST_DATABASE_URL: dbUrl,
        ENCRYPTION_KEY: testEncryptionKey,
      },
      encoding: 'utf8',
    });
    expect(out1).toContain('STEP_1_SUCCESS');
    expect(findSqliteFiles()).toHaveLength(0);

    // 2. Spawn Subprocess 2: Independent fresh Node runtime reads data, asserts equality, updates it
    const scriptStep2 = `
      import { initDb, closeDb, setSetting, getSetting } from './src/db/index.ts';
      process.env.DATABASE_URL = ${JSON.stringify(dbUrl)};
      process.env.ENCRYPTION_KEY = ${JSON.stringify(testEncryptionKey)};

      async function run() {
        const db = await initDb();
        const read = await getSetting(${JSON.stringify(testKeyName)});
        if (read !== ${JSON.stringify(testValueInitial)}) {
          console.error('Mismatch in process 2 initial read:', read);
          process.exit(1);
        }
        await setSetting(${JSON.stringify(testKeyName)}, ${JSON.stringify(testValueUpdated)});
        await closeDb();
        console.log('STEP_2_SUCCESS');
      }
      run().catch(err => {
        console.error(err);
        process.exit(1);
      });
    `;

    const out2 = execFileSync(tsxBin, ['-e', scriptStep2], {
      cwd: serverRoot,
      env: {
        ...process.env,
        DATABASE_URL: dbUrl,
        TEST_DATABASE_URL: dbUrl,
        ENCRYPTION_KEY: testEncryptionKey,
      },
      encoding: 'utf8',
    });
    expect(out2).toContain('STEP_2_SUCCESS');
    expect(findSqliteFiles()).toHaveLength(0);

    // 3. Verify in current test process that updated value was persisted by Process 2
    const inProcessRead = await getSetting(testKeyName);
    expect(inProcessRead).toBe(testValueUpdated);
    expect(findSqliteFiles()).toHaveLength(0);
  });

  it('persists encrypted provider credentials across process restart and decrypts accurately', async () => {
    const rawApiKey = `sk-test-live-key-${Date.now()}`;
    const keyLabel = `cred_test_${Date.now()}`;

    // Subprocess 1: Encrypt credential, write to api_keys table, and exit
    const writeScript = `
      import { initDb, closeDb } from './src/db/index.ts';
      import { initEncryptionKey, encrypt } from './src/lib/crypto.ts';

      async function run() {
        const db = await initDb();
        await initEncryptionKey(db);
        const enc = encrypt(${JSON.stringify(rawApiKey)});
        await db.run(
          'INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ['groq', ${JSON.stringify(keyLabel)}, enc.encrypted, enc.iv, enc.authTag, 'healthy', 1]
        );
        await closeDb();
        console.log('WRITE_CRED_SUCCESS');
      }
      run().catch(err => { console.error(err); process.exit(1); });
    `;

    const writeOut = execFileSync(tsxBin, ['-e', writeScript], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: dbUrl, ENCRYPTION_KEY: testEncryptionKey },
      encoding: 'utf8',
    });
    expect(writeOut).toContain('WRITE_CRED_SUCCESS');

    // Subprocess 2: Fresh process boots, queries row, decrypts, and asserts plaintext match
    const readScript = `
      import { initDb, closeDb } from './src/db/index.ts';
      import { initEncryptionKey, decrypt } from './src/lib/crypto.ts';

      async function run() {
        const db = await initDb();
        await initEncryptionKey(db);
        const row = await db.get(
          'SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE label = ?',
          [${JSON.stringify(keyLabel)}]
        );
        if (!row) {
          console.error('Row not found');
          process.exit(1);
        }
        const decrypted = decrypt(row.encrypted_key, row.iv, row.auth_tag);
        if (decrypted !== ${JSON.stringify(rawApiKey)}) {
          console.error('Decrypted mismatch:', decrypted);
          process.exit(1);
        }
        await closeDb();
        console.log('READ_CRED_SUCCESS');
      }
      run().catch(err => { console.error(err); process.exit(1); });
    `;

    const readOut = execFileSync(tsxBin, ['-e', readScript], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: dbUrl, ENCRYPTION_KEY: testEncryptionKey },
      encoding: 'utf8',
    });
    expect(readOut).toContain('READ_CRED_SUCCESS');
  });

  it('rolls back aborted transactions and prevents partial writes across processes', async () => {
    const rolledBackKey = `rollback_probe_${Date.now()}`;

    // Subprocess 1: Attempts transaction, writes row, then throws to trigger ROLLBACK
    const txFailScript = `
      import { initDb, closeDb } from './src/db/index.ts';

      async function run() {
        const db = await initDb();
        try {
          await db.transaction(async (tx) => {
            await tx.run('INSERT INTO settings (key, value) VALUES (?, ?)', [${JSON.stringify(rolledBackKey)}, 'uncommitted']);
            throw new Error('Simulated transactional failure');
          });
        } catch {
          // Expected error caught
        }
        await closeDb();
        console.log('TX_ABORT_DONE');
      }
      run().catch(err => { console.error(err); process.exit(1); });
    `;

    const txOut = execFileSync(tsxBin, ['-e', txFailScript], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: dbUrl, ENCRYPTION_KEY: testEncryptionKey },
      encoding: 'utf8',
    });
    expect(txOut).toContain('TX_ABORT_DONE');

    // Subprocess 2: Confirms the row was never committed
    const verifyScript = `
      import { initDb, closeDb, getSetting } from './src/db/index.ts';

      async function run() {
        await initDb();
        const val = await getSetting(${JSON.stringify(rolledBackKey)});
        if (val !== undefined) {
          console.error('Data leaked across rolled back transaction:', val);
          process.exit(1);
        }
        await closeDb();
        console.log('VERIFY_ROLLBACK_SUCCESS');
      }
      run().catch(err => { console.error(err); process.exit(1); });
    `;

    const verifyOut = execFileSync(tsxBin, ['-e', verifyScript], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: dbUrl, ENCRYPTION_KEY: testEncryptionKey },
      encoding: 'utf8',
    });
    expect(verifyOut).toContain('VERIFY_ROLLBACK_SUCCESS');
  });

  it('distinguishes process liveness (/api/ping) from database readiness (/api/ready)', async () => {
    const app = createApp();
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const addr = server.address() as any;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // 1. Liveness check: process is alive
      const pingRes = await fetch(`${baseUrl}/api/ping`);
      expect(pingRes.status).toBe(200);
      const pingJson = await pingRes.json() as any;
      expect(pingJson.status).toBe('ok');

      // 2. Readiness check: database is connected and responding
      const readyRes = await fetch(`${baseUrl}/api/ready`);
      expect(readyRes.status).toBe(200);
      const readyJson = await readyRes.json() as any;
      expect(readyJson.status).toBe('ready');
      expect(readyJson.database).toBe('connected');
    } finally {
      server.close();
    }
  });
});
