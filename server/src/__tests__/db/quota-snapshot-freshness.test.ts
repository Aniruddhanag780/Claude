import { beforeEach, expect, it } from 'vitest';
import { getDb } from '../../db/index.js';
import { up, down } from '../../db/migrations/20260915_000001_quota_snapshot_freshness.js';
import { recordQuotaObservation } from '../../services/provider-quota.js';
import { initTestDb } from '../helpers/test-db.js';

beforeEach(async () => { process.env.ENCRYPTION_KEY='0'.repeat(64);await initTestDb(); });

it('repairs probe-refreshed balances from the last real measurement, preserving empty probe history', async () => {
  await recordQuotaObservation({platform:'groq',keyId:1,limit:100,remaining:20,resetAt:'2026-09-15T13:00:00Z',
    source:'header',observedAt:'2026-09-15T11:00:00Z'});
  await recordQuotaObservation({platform:'groq',keyId:1,source:'probe',confidence:0.1,observedAt:'2026-09-15T12:00:00Z'});
  (await getDb().run("UPDATE provider_quota_state SET remaining_value=100,reset_at=NULL,observed_at='2026-09-15 12:00:00',notes='no quota headers exposed'"));
  const history=(await getDb().all('SELECT * FROM provider_quota_observations'));
  await up(getDb());
  expect((await getDb().get('SELECT remaining_value,reset_at,observed_at,confidence,notes FROM provider_quota_state')))
    .toEqual({remaining_value:20,reset_at:'2026-09-15T13:00:00Z',observed_at:'2026-09-15 11:00:00.000',confidence:1,notes:null});
  expect((await getDb().all('SELECT * FROM provider_quota_observations'))).toEqual(history);
  const repaired=(await getDb().all('SELECT * FROM provider_quota_state'));
  await up(getDb());await down(getDb());
  expect((await getDb().all('SELECT * FROM provider_quota_state'))).toEqual(repaired);
});

it('does not retain borrowed confidence or guess the age of a pruned balance', async () => {
  await recordQuotaObservation({platform:'groq',keyId:1,remaining:0,source:'error_body',confidence:1});
  await recordQuotaObservation({platform:'cerebras',keyId:2,remaining:50,limit:100,source:'header'});
  (await getDb().run("DELETE FROM provider_quota_observations WHERE platform='cerebras'"));
  await up(getDb());
  expect((await getDb().get("SELECT confidence FROM provider_quota_state WHERE platform='groq'"))).toEqual({confidence:0.55});
  expect((await getDb().get("SELECT remaining_value,confidence FROM provider_quota_state WHERE platform='cerebras'"))).toEqual({remaining_value:50,confidence:0});
});
