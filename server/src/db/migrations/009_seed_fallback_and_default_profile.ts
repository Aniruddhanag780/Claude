import pg from 'pg';

export async function up(client: pg.PoolClient | pg.Pool): Promise<void> {
  // 1. Populate fallback_config from models if fallback_config is empty
  //
  // `fallback_config.priority` is a CHAIN POSITION, not a quality score: the
  // router walks the chain ordered by `priority ASC` and densely renumbers the
  // survivors 1..N, and catalog-sync appends a newly seen model at
  // `MAX(priority) + 1` — i.e. at the END of the chain. `models.priority` is
  // the opposite scale (the fork's seed gives the flagship models 10 and the
  // weaker ones 3), so copying it verbatim inverted the chain: the worst model
  // was served first. Rank the models instead — highest quality first, dense
  // positions 1..N.
  const fbCountRes = await client.query('SELECT COUNT(*) as cnt FROM fallback_config');
  const fbCount = Number(fbCountRes.rows[0]?.cnt ?? 0);
  if (fbCount === 0) {
    const modelsRes = await client.query('SELECT id, priority FROM models ORDER BY priority DESC, id ASC');
    let position = 0;
    for (const m of modelsRes.rows) {
      position += 1;
      await client.query(
        'INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES ($1, $2, 1) ON CONFLICT (model_db_id) DO NOTHING',
        [m.id, position],
      );
    }
  }

  // 2. Ensure the Default profile exists (required by named chains and routing)
  const profCountRes = await client.query(
    "SELECT COUNT(*) as cnt FROM profiles WHERE type = 'default' OR type = 'builtin'",
  );
  const profCount = Number(profCountRes.rows[0]?.cnt ?? 0);
  if (profCount === 0) {
    const minOrderRes = await client.query('SELECT COALESCE(MIN(sort_order), 0) AS mn FROM profiles');
    const minOrder = Number(minOrderRes.rows[0]?.mn ?? 0);
    const targetOrder = Math.min(-1, minOrder - 1);

    const inserted = await client.query(`
      INSERT INTO profiles (name, emoji, color, type, sort_order, auto_include_new_models)
      VALUES ('Default', '⚙️', '#6366f1', 'default', $1, 1)
      RETURNING id
    `, [targetOrder]);
    const profileId = Number(inserted.rows[0].id);

    // Seed profile_models from fallback_config
    const fbRes = await client.query('SELECT model_db_id, priority, enabled FROM fallback_config ORDER BY priority ASC');
    for (const fb of fbRes.rows) {
      await client.query(
        'INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES ($1, $2, $3, $4) ON CONFLICT (profile_id, model_db_id) DO NOTHING',
        [profileId, fb.model_db_id, fb.priority, fb.enabled],
      );
    }

    // Set as active profile if none set
    await client.query(`
      INSERT INTO settings (key, value)
      VALUES ('active_profile_id', $1)
      ON CONFLICT (key) DO NOTHING
    `, [String(profileId)]);
  }
}

export async function down(client: pg.PoolClient | pg.Pool): Promise<void> {
  await client.query("DELETE FROM profiles WHERE type = 'default'");
  await client.query('DELETE FROM fallback_config');
}
