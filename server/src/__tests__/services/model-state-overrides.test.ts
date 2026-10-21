import { beforeEach, it, expect } from 'vitest';
import { getDb, setSetting } from '../../db/index.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { upsertModelOverrides, applyModelOverrides, getModelOverrides } from '../../services/model-state.js';
import { initTestDb } from '../helpers/test-db.js';

const model = {
  platform: 'groq', modelId: 'override-test', displayName: 'Catalog name', intelligenceRank: 1,
  speedRank: 1, sizeLabel: 'Small', limits: {rpm:30,rpd:null,tpm:null,tpd:null},
  monthlyTokenBudget: '', contextWindow: 8000, enabled:true, supportsVision:false, supportsTools:true,
};
const catalog = (displayName = model.displayName) => ({version:'2099.01.01',generatedAt:new Date().toISOString(),tier:'live' as const,models:[{...model,displayName}],quirks:[]});
const row = async () => (await getDb().get("SELECT * FROM models WHERE model_id = 'override-test'")) as Record<string,unknown>;
const stored = async () => (await getDb().get("SELECT * FROM model_overrides WHERE model_id = 'override-test'"));
async function legacyOverride() {
  (await getDb().run("INSERT INTO model_overrides(platform,model_id,overrides_json) VALUES ('groq','override-test',?)", [JSON.stringify({displayName:'Legacy custom name'})]));
  await applyModelOverrides(getDb(),'groq','override-test');
}
beforeEach(async () => {process.env.ENCRYPTION_KEY = '0'.repeat(64); await initTestDb(); await applyCatalog(getDb(),catalog());});

it('clears a legacy override using the cached catalog instead of the effective row', async () => {
  await setSetting('catalog_applied_json',JSON.stringify(catalog())); await legacyOverride();
  await upsertModelOverrides(getDb(),'groq','override-test',{displayName:model.displayName},{baselineRow:await row()});
  expect(await stored()).toBeUndefined();
});
it('does not erase an unknown legacy override merely because it matches the effective row', async () => {
  await legacyOverride();
  await upsertModelOverrides(getDb(),'groq','override-test',{displayName:'Legacy custom name'},{baselineRow:await row()});
  expect((await getModelOverrides(getDb(),'groq','override-test')).displayName).toBe('Legacy custom name');
  // The next catalog refresh recovers the authoritative baseline offline too.
  await applyCatalog(getDb(),catalog());
  await upsertModelOverrides(getDb(),'groq','override-test',{displayName:model.displayName},{baselineRow:await row()});
  expect(await stored()).toBeUndefined();
});
it('refreshes the undo baseline when a newer catalog changes the default', async () => {
  await upsertModelOverrides(getDb(),'groq','override-test',{displayName:'Local name'},{baselineRow:await row()});
  await applyModelOverrides(getDb(),'groq','override-test');
  await applyCatalog(getDb(),catalog('New catalog name'));
  expect((await row()).display_name).toBe('Local name');
  await upsertModelOverrides(getDb(),'groq','override-test',{displayName:'New catalog name'},{baselineRow:await row()});
  expect(await stored()).toBeUndefined();
});
it('preserves explicit declarative pins even when they match a known baseline', async () => {
  await upsertModelOverrides(getDb(),'groq','override-test',{displayName:'Local name'},{baselineRow:await row()});
  await upsertModelOverrides(getDb(),'groq','override-test',{displayName:model.displayName});
  await applyCatalog(getDb(),catalog('Next default'));
  expect((await row()).display_name).toBe(model.displayName);
});
it('drops restored boolean and null fields while keeping unrelated edits', async () => {
  const baselineRow = await row();
  await upsertModelOverrides(getDb(),'groq','override-test',{displayName:'Local name',supportsVision:true,rpdLimit:50},{baselineRow});
  await applyModelOverrides(getDb(),'groq','override-test');
  await upsertModelOverrides(getDb(),'groq','override-test',{supportsVision:false,rpdLimit:null},{baselineRow:await row()});
  const overrides = await getModelOverrides(getDb(),'groq','override-test');
  expect(overrides.displayName).toBe('Local name');
  expect(overrides.supportsVision).toBeUndefined();
  expect(overrides.rpdLimit).toBeUndefined();
});
