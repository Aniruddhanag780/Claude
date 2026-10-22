import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initTestDb } from '../helpers/test-db.js';
import { getDb, setSetting, getSetting } from '../../db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const repoRoot = path.resolve(serverRoot, '..');
const tsxBin = fs.existsSync(path.resolve(serverRoot, 'node_modules/.bin/tsx'))
  ? path.resolve(serverRoot, 'node_modules/.bin/tsx')
  : path.resolve(repoRoot, 'node_modules/.bin/tsx');

describe('Process Restart & Database Persistence Verification', () => {
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

  it('persists data across independent operating system process boundaries without SQLite', async () => {
    // 1. Assert no SQLite files exist before execution
    const findSqliteFiles = () => {
      const candidates = ['freellmapi.db', 'data/freellmapi.db', 'freellmapi.sqlite', 'test.db'];
      return candidates.filter(f => fs.existsSync(path.join(serverRoot, f)));
    };
    expect(findSqliteFiles()).toHaveLength(0);

    // 2. Spawn Subprocess 1: Initialize DB, write test key, verify, and exit
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

    // 3. Spawn Subprocess 2: Independent fresh Node runtime reads data, asserts equality, updates it
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

    // 4. Verify in current test process that updated value was persisted by Process 2
    const inProcessRead = await getSetting(testKeyName);
    expect(inProcessRead).toBe(testValueUpdated);
    expect(findSqliteFiles()).toHaveLength(0);
  });
});
