import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePostgresPool, getUnifiedApiKey, initDb } from '../../../db/index.js';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_CI = process.env.CI;
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ORIGINAL_KUBERNETES_SERVICE_HOST = process.env.KUBERNETES_SERVICE_HOST;
const ORIGINAL_STDOUT_TTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

describe('legacy baseline unified API key output', () => {
  let output: string[];

  beforeEach(() => {
    output = [];
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env.KUBERNETES_SERVICE_HOST;
    delete process.env.CI;

    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    restoreEnv('NODE_ENV', ORIGINAL_NODE_ENV);
    restoreEnv('CI', ORIGINAL_CI);
    restoreEnv('ENCRYPTION_KEY', ORIGINAL_ENCRYPTION_KEY);
    restoreEnv('KUBERNETES_SERVICE_HOST', ORIGINAL_KUBERNETES_SERVICE_HOST);

    if (ORIGINAL_STDOUT_TTY) {
      Object.defineProperty(process.stdout, 'isTTY', ORIGINAL_STDOUT_TTY);
    } else {
      Reflect.deleteProperty(process.stdout, 'isTTY');
    }
    await closePostgresPool();
  });

  it('does not put a fresh key in production logs, even with an attached TTY', async () => {
    process.env.NODE_ENV = 'production';
    setStdoutTTY(true);

    const key = await runBaselineAndReadKey();

    expect(output.join('')).not.toContain(key);
    expect(output.join('')).toContain('dashboard');
    expect(output.join('')).toContain('Keys page');
  });

  it('does not put a fresh key in non-TTY development logs', async () => {
    process.env.NODE_ENV = 'development';
    setStdoutTTY(false);

    const key = await runBaselineAndReadKey();

    expect(output.join('')).not.toContain(key);
    expect(output.join('')).toContain('dashboard');
    expect(output.join('')).toContain('Keys page');
  });

  it('does not disclose a key from a Kubernetes TTY', async () => {
    process.env.NODE_ENV = 'development';
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    setStdoutTTY(true);

    const key = await runBaselineAndReadKey();

    expect(output.join('')).not.toContain(key);
    expect(output.join('')).toContain('not printed to logs');
  });

  it('does not disclose a key in CI even with a development TTY', async () => {
    process.env.NODE_ENV = 'development';
    process.env.CI = 'true';
    setStdoutTTY(true);

    const key = await runBaselineAndReadKey();

    expect(output.join('')).not.toContain(key);
    expect(output.join('')).toContain('not printed to logs');
  });

  it('discloses the full key only for interactive local development', async () => {
    process.env.NODE_ENV = 'development';
    setStdoutTTY(true);

    const key = await runBaselineAndReadKey();

    expect(output.join('')).toContain(`Your unified API key: ${key}`);
  });
});

async function runBaselineAndReadKey(): Promise<string> {
  await closePostgresPool();
  await initDb(':memory:');
  return getUnifiedApiKey();
}

function setStdoutTTY(value: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value,
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
