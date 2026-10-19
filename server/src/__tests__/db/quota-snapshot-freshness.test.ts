import { beforeEach, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
function up(db: any): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_quota_balance_observations
    ON provider_quota_observations(platform,key_id,quota_pool_key,metric,observed_at DESC,created_at DESC)
    WHERE remaining_value IS NOT NULL`);
  const snapshot = db.prepare(`SELECT * FROM provider_quota_observations
    WHERE platform=? AND key_id=? AND quota_pool_key=? AND metric=? AND remaining_value IS NOT NULL
    ORDER BY observed_at DESC,created_at DESC LIMIT 1`);
  const update = db.prepare(`UPDATE provider_quota_state SET limit_value=?,remaining_value=?,reset_at=?,
    reset_strategy=?,source=?,confidence=?,notes=?,observed_at=?
    WHERE platform=? AND key_id=? AND quota_pool_key=? AND metric=?`);
  const uncertain = db.prepare(`UPDATE provider_quota_state SET confidence=0
    WHERE platform=? AND key_id=? AND quota_pool_key=? AND metric=?`);
  const confidenceCap: Record<string, number> = { header:1,quota_api:1,error_body:0.55,probe:0.1,local_usage:0.45,documentation:0.35 };
  const rows = db.prepare('SELECT platform,key_id,quota_pool_key,metric FROM provider_quota_state').all() as {
    platform:string;key_id:number;quota_pool_key:string;metric:string;
  }[];
  for (const row of rows) {
    const identity = [row.platform,row.key_id,row.quota_pool_key,row.metric];
    const measured = snapshot.get(...identity) as {
      limit_value:number|null;remaining_value:number;reset_at:string|null;reset_strategy:string;
      source:string;confidence:number;notes:string|null;observed_at:string;
    } | undefined;
    if (measured) update.run(measured.limit_value,measured.remaining_value,measured.reset_at,
      measured.reset_strategy,measured.source,Math.min(measured.confidence,confidenceCap[measured.source] ?? 0),
      measured.notes,measured.observed_at,...identity);
    else uncertain.run(...identity);
  }
}

function down(db: any): void {
  db.exec('DROP INDEX IF EXISTS idx_quota_balance_observations');
}

import { recordQuotaObservation } from '../../services/provider-quota.js';

beforeEach(() => { process.env.ENCRYPTION_KEY='0'.repeat(64);initDb(':memory:'); });

it('repairs probe-refreshed balances from the last real measurement, preserving empty probe history', () => {
  recordQuotaObservation({platform:'groq',keyId:1,limit:100,remaining:20,resetAt:'2026-09-15T13:00:00Z',
    source:'header',observedAt:'2026-09-15T11:00:00Z'});
  recordQuotaObservation({platform:'groq',keyId:1,source:'probe',confidence:0.1,observedAt:'2026-09-15T12:00:00Z'});
  getDb().prepare("UPDATE provider_quota_state SET remaining_value=100,reset_at=NULL,observed_at='2026-09-15 12:00:00',notes='no quota headers exposed'").run();
  const history=getDb().prepare('SELECT * FROM provider_quota_observations').all();
  up(getDb());
  expect(getDb().prepare('SELECT remaining_value,reset_at,observed_at,confidence,notes FROM provider_quota_state').get())
    .toEqual({remaining_value:20,reset_at:'2026-09-15T13:00:00Z',observed_at:'2026-09-15 11:00:00.000',confidence:1,notes:null});
  expect(getDb().prepare('SELECT * FROM provider_quota_observations').all()).toEqual(history);
  const repaired=getDb().prepare('SELECT * FROM provider_quota_state').all();
  up(getDb());down(getDb());
  expect(getDb().prepare('SELECT * FROM provider_quota_state').all()).toEqual(repaired);
});

it('does not retain borrowed confidence or guess the age of a pruned balance', () => {
  recordQuotaObservation({platform:'groq',keyId:1,remaining:0,source:'error_body',confidence:1});
  recordQuotaObservation({platform:'cerebras',keyId:2,remaining:50,limit:100,source:'header'});
  getDb().prepare("DELETE FROM provider_quota_observations WHERE platform='cerebras'").run();
  up(getDb());
  expect(getDb().prepare("SELECT confidence FROM provider_quota_state WHERE platform='groq'").get()).toEqual({confidence:0.55});
  expect(getDb().prepare("SELECT remaining_value,confidence FROM provider_quota_state WHERE platform='cerebras'").get()).toEqual({remaining_value:50,confidence:0});
});
