import { describe, expect, it } from 'vitest';
import { resolveSslConfig } from '../../db/postgres.js';

// The pool used to force `ssl: { rejectUnauthorized: false }` for every
// non-local URL — certificate verification was never performed. Worse, pg
// merges the parsed connection string OVER programmatic config, so that
// insecure value only applied when the URL *omitted* sslmode: inconsistent and
// unsafe by default. These pin resolveSslConfig: verify by default, honour an
// explicit URL sslmode verbatim, keep local dev separate, and allow
// verification to be disabled only via an explicit opt-out.
describe('resolveSslConfig', () => {
  const NEON = 'postgresql://user:pass@ep-abc123.us-east-2.aws.neon.tech/neondb';
  const LOCAL = 'postgresql://postgres:pass@127.0.0.1:5432/freellm';

  it('verifies the certificate for a non-local host with no explicit sslmode', () => {
    const r = resolveSslConfig(NEON, {});
    expect(r.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('does NOT disable verification for a non-local host (the old defect)', () => {
    const r = resolveSslConfig(NEON, {});
    expect(r.ssl).not.toEqual({ rejectUnauthorized: false });
  });

  it('defers to an explicit sslmode in the URL instead of overriding it', () => {
    // pg applies the URL's sslmode itself; we must not set a conflicting value.
    const r = resolveSslConfig(`${NEON}?sslmode=require`, {});
    expect(r.ssl).toBeUndefined();
  });

  it('defers to explicit sslrootcert/sslcert/sslkey in the URL', () => {
    expect(resolveSslConfig(`${NEON}?sslrootcert=/ca.pem`, {}).ssl).toBeUndefined();
    expect(resolveSslConfig(`${NEON}?sslmode=verify-full&sslrootcert=/ca.pem`, {}).ssl).toBeUndefined();
  });

  it('uses a plain connection for local dev hosts', () => {
    expect(resolveSslConfig(LOCAL, {}).ssl).toBeUndefined();
    expect(resolveSslConfig('postgresql://postgres@localhost/freellm', {}).ssl).toBeUndefined();
  });

  it('honours PGSSL_NO_VERIFY as an explicit opt-out for non-local hosts', () => {
    const r = resolveSslConfig(NEON, { PGSSL_NO_VERIFY: 'true' });
    expect(r.ssl).toEqual({ rejectUnauthorized: false });
    expect(r.reason).toMatch(/opt-out/i);
  });

  it('treats any other PGSSL_NO_VERIFY value as verification ON (default)', () => {
    expect(resolveSslConfig(NEON, { PGSSL_NO_VERIFY: 'false' }).ssl).toEqual({ rejectUnauthorized: true });
    expect(resolveSslConfig(NEON, { PGSSL_NO_VERIFY: '' }).ssl).toEqual({ rejectUnauthorized: true });
    expect(resolveSslConfig(NEON, { PGSSL_NO_VERIFY: '0' }).ssl).toEqual({ rejectUnauthorized: true });
  });

  it('does not apply PGSSL_NO_VERIFY to local hosts (still plain)', () => {
    expect(resolveSslConfig(LOCAL, { PGSSL_NO_VERIFY: 'true' }).ssl).toBeUndefined();
  });

  it('falls back safely on an unparsable connection string', () => {
    const r = resolveSslConfig('not a url', {});
    expect(r.ssl).toBeUndefined();
  });
});
