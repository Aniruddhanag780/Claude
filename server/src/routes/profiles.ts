/**
 * Express router handles CRUD endpoints for named model fallback profiles.
 * Profiles allow users to maintain different prioritized chains of LLMs.
 * Features include metadata updates, reordering fallback priority, auto-sorting presets,
 * and built-in safety blocks to prevent modification of default settings.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb, query, transaction } from '../db/index.js';
import { monthlyBudgetScore } from '../lib/budget.js';

export const profilesRouter = Router();

const RESERVED_PROFILE_NAMES = [
  'auto', 'smart', 'fast', 'cheap', 'budget',
  'intelligence', 'speed', 'active', 'default',
];

const profileNameSchema = z
  .string()
  .min(1, 'Profile name cannot be empty')
  .max(20, 'Profile name must not exceed 20 characters')
  .regex(
    /^[a-zA-Z0-9-_]+$/,
    'Only Latin letters, digits, hyphens (-) and underscores (_) are allowed'
  )
  .refine(
    (name) => !RESERVED_PROFILE_NAMES.includes(name.toLowerCase()),
    'This name is reserved by the system'
  );

const createSchema = z.object({
  name: profileNameSchema,
  emoji: z.string().max(4).default(''),
  color: z.string().default('#6366f1'),
  sourceProfileId: z.number().optional(),
  // Start the chain with nothing in it instead of a copy of the whole catalog
  // (#895). The point of a named chain is usually "these three models, in this
  // order" — starting from 200 rows means deleting 197 of them by hand. An
  // empty chain also opts out of the catalog-sync backfill, so it stays as
  // small as the user built it.
  empty: z.boolean().default(false),
});

const updateSchema = z.object({
  name: profileNameSchema.optional(),
  emoji: z.string().max(4).optional(),
  color: z.string().optional(),
  is_favorite: z.boolean().optional(),
  sort_order: z.number().optional(),
  auto_sort: z.enum(['intelligence', 'speed', 'budget']).nullable().optional(),
  layout_config: z.string().nullable().optional(),
  auto_include_new_models: z.boolean().optional(),
});

function getId(req: Request): number {
  return parseInt(req.params.id as string);
}

async function rowOr404(
  res: Response,
  sql: string,
  params: any[],
  label: string,
): Promise<any | null> {
  const result = await query(sql, params);
  const row = result.rows[0] ?? null;
  if (!row) {
    res.status(404).json({ error: { message: `${label} not found` } });
    return null;
  }
  return row;
}

/**
 * GET /api/profiles
 * Fetches all available profiles.
 * Sorting order: Default profile first -> Favorited profiles -> Custom sorting order.
 */
profilesRouter.get('/', async (_req: Request, res: Response) => {
  const profiles = await query(
    `SELECT id, name, emoji, color, type, is_favorite, sort_order, auto_sort, layout_config, auto_include_new_models, created_at
     FROM profiles
     ORDER BY (CASE WHEN type = 'default' THEN 1 ELSE 0 END) DESC, is_favorite DESC, sort_order ASC, id ASC`,
  );
  res.json(profiles.rows);
});

// GET /api/profiles/active — get the currently active profile id
profilesRouter.get('/active', async (_req: Request, res: Response) => {
  const result = await query(`SELECT value FROM settings WHERE key = 'active_profile_id'`);
  const row = result.rows[0] as { value: string } | undefined;
  const activeProfileId = row ? (parseInt(row.value) || null) : null;
  res.json({ activeProfileId });
});

// POST /api/profiles/active — set or clear the active profile
profilesRouter.post('/active', async (req: Request, res: Response) => {
  const profileId = req.body?.profileId;

  if (profileId === null || profileId === undefined) {
    await query(`DELETE FROM settings WHERE key = 'active_profile_id'`);
    res.json({ activeProfileId: null });
    return;
  }

  const profile = await rowOr404(
    res,
    'SELECT id FROM profiles WHERE id = $1',
    [Number(profileId)],
    'Profile',
  );
  if (!profile) return;

  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ['active_profile_id', String(profileId)],
  );
  res.json({ activeProfileId: Number(profileId) });
});

// GET /api/profiles/:id/models — get profile model order
profilesRouter.get('/:id/models', async (req: Request, res: Response) => {
  const profileId = getId(req);
  const profile = await rowOr404(
    res,
    'SELECT id FROM profiles WHERE id = $1',
    [profileId],
    'Profile',
  );
  if (!profile) return;

  const rows = await query(
    `SELECT pm.model_db_id, pm.priority, pm.enabled,
            p.provider_key AS platform, m.model_id, m.display_name, m.intelligence_rank,
            m.speed_rank, m.size_label, m.rpm_limit, m.rpd_limit,
            m.tpm_limit, m.tpd_limit,
            m.monthly_token_budget
     FROM profile_models pm
     JOIN models m ON m.id = pm.model_db_id
     JOIN providers p ON p.id = m.provider_id
     WHERE pm.profile_id = $1 AND m.enabled
     ORDER BY pm.priority ASC`,
    [profileId],
  );

  // Normalize SQLite 0/1 integers (mock) and booleans (Postgres) for the client
  res.json(rows.rows.map((r: any) => ({ ...r, enabled: Boolean(r.enabled) })));
});

/**
 * POST /api/profiles
 * Creates a new custom profile.
 * Allows optional cloning of the active profile's model priority and layout configuration.
 */
profilesRouter.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { name, emoji, color, sourceProfileId, empty } = parsed.data;

  // Check for case-insensitive duplicate profile names
  const duplicate = await query('SELECT id FROM profiles WHERE LOWER(name) = LOWER($1)', [name]);
  if (duplicate.rows[0]) {
    res.status(409).json({ error: { message: `Profile with name '${name}' already exists` } });
    return;
  }

  const maxOrder = (await query('SELECT COALESCE(MAX(sort_order), 0) AS mx FROM profiles')).rows[0] as { mx: number };

  let layoutConfig: string | null = null;
  let autoSort: string | null = null;
  if (sourceProfileId) {
    const source = await query('SELECT layout_config, auto_sort FROM profiles WHERE id = $1', [sourceProfileId]);
    if (source.rows[0]) {
      layoutConfig = source.rows[0].layout_config;
      autoSort = source.rows[0].auto_sort;
    }
  }

  const profileId = await transaction(async (client: any) => {
    const ins = await client.query(
      'INSERT INTO profiles (name, emoji, color, type, sort_order, layout_config, auto_sort, auto_include_new_models) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [name, emoji, color, 'custom', maxOrder.mx + 1, layoutConfig, autoSort, empty ? 0 : 1],
    );
    const id = Number(ins.rows[0].id);

    // `empty` wins over `sourceProfileId`: it is the more specific of the two
    // requests, and copying a source chain in would defeat the point of it.
    if (!empty) {
      const source = sourceProfileId
        ? await client.query('SELECT id FROM profiles WHERE id = $1', [sourceProfileId])
        : null;
      if (source?.rows[0]) {
        const models = await client.query(
          'SELECT model_db_id, priority, enabled FROM profile_models WHERE profile_id = $1 ORDER BY priority ASC',
          [sourceProfileId],
        );
        for (const m of models.rows) {
          await client.query(
            'INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES ($1, $2, $3, $4)',
            [id, m.model_db_id, m.priority, m.enabled],
          );
        }
      } else {
        await copyFromDefault(client, id);
      }
    }
    return id;
  });

  const created = await query(
    'SELECT id, name, emoji, color, type, is_favorite, sort_order, auto_sort, layout_config, auto_include_new_models, created_at FROM profiles WHERE id = $1',
    [profileId],
  );
  res.status(201).json(created.rows[0]);
});

async function copyFromDefault(client: any, profileId: number) {
  const rows = await client.query(
    'SELECT model_db_id, priority, enabled FROM fallback_config ORDER BY priority ASC',
  );
  for (const m of rows.rows) {
    await client.query(
      'INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES ($1, $2, $3, $4)',
      [profileId, m.model_db_id, m.priority, m.enabled],
    );
  }
}

// PUT /api/profiles/:id — update profile metadata
profilesRouter.put('/:id', async (req: Request, res: Response) => {
  const profileId = getId(req);
  const profile = await rowOr404(
    res,
    'SELECT id, name, type FROM profiles WHERE id = $1',
    [profileId],
    'Profile',
  );
  if (!profile) return;

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const isProtected = profile.type === 'default' || profile.type === 'builtin';

  // A chain's name is the address clients route with (auto:<name>), and the
  // built-in names are fixed in docs and client configs. Say so with a 403
  // rather than silently dropping the rename (#1179); an unchanged name sent
  // along with other fields still passes.
  if (isProtected && parsed.data.name !== undefined && parsed.data.name !== profile.name) {
    res.status(403).json({ error: { message: 'Built-in chains cannot be renamed' } });
    return;
  }

  // Check for case-insensitive duplicate profile names when editing name
  if (parsed.data.name !== undefined) {
    const duplicate = await query(
      'SELECT id FROM profiles WHERE LOWER(name) = LOWER($1) AND id != $2',
      [parsed.data.name, profileId],
    );
    if (duplicate.rows[0]) {
      res.status(409).json({ error: { message: `Profile with name '${parsed.data.name}' already exists` } });
      return;
    }
  }

  const updates: string[] = [];
  const values: any[] = [];
  let param = 1;
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) {
      // Block name/emoji/color edits on protected profiles
      if (isProtected && (key === 'name' || key === 'emoji' || key === 'color')) {
        continue;
      }
      if (key === 'is_favorite' || key === 'auto_include_new_models') {
        updates.push(`${key} = $${param}`);
        values.push(value ? 1 : 0);
      } else {
        updates.push(`${key} = $${param}`);
        values.push(value);
      }
      param += 1;
    }
  }

  if (updates.length > 0) {
    values.push(profileId);
    await transaction(async (client: any) => {
      await client.query(`UPDATE profiles SET ${updates.join(', ')} WHERE id = $${param}`, values);
    });
  }

  // If auto_sort was updated to a preset, automatically physically sort the models in DB
  if (parsed.data.auto_sort) {
    await sortProfileModels(getDb(), profileId, parsed.data.auto_sort);
  }

  const updated = await query(
    'SELECT id, name, emoji, color, type, is_favorite, sort_order, auto_sort, layout_config, auto_include_new_models, created_at FROM profiles WHERE id = $1',
    [profileId],
  );
  res.json(updated.rows[0]);
});

// PUT /api/profiles/:id/reorder — update model order + enabled for a profile
const reorderSchema = z.array(z.object({
  modelDbId: z.number(),
  priority: z.number(),
  enabled: z.boolean(),
}));

profilesRouter.put('/:id/reorder', async (req: Request, res: Response) => {
  const profileId = getId(req);
  const profile = await rowOr404(
    res,
    'SELECT id FROM profiles WHERE id = $1',
    [profileId],
    'Profile',
  );
  if (!profile) return;

  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  await transaction(async (client: any) => {
    await client.query('DELETE FROM profile_models WHERE profile_id = $1', [profileId]);
    const insert = `INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES ($1, $2, $3, $4)`;
    for (const entry of parsed.data) {
      await client.query(insert, [profileId, entry.modelDbId, entry.priority, entry.enabled ? 1 : 0]);
    }
  });

  res.json({ success: true });
});

// POST /api/profiles/:id/reset — reset a profile to fallback baseline
profilesRouter.post('/:id/reset', async (req: Request, res: Response) => {
  const profileId = getId(req);
  const profile = await rowOr404(
    res,
    'SELECT id FROM profiles WHERE id = $1',
    [profileId],
    'Profile',
  );
  if (!profile) return;

  const baselineLayout = JSON.stringify({
    viewMode: "list",
    compactMode: false,
    limitsMode: false,
    limitsVariant: "circle",
    sortDisabledToBottom: false,
    kanbanLayout: [{ id: "board-default", type: "board", title: "Default", emoji: "📋", color: "rgb(99, 102, 241)", collapsed: false, items: [] }],
    tierLayout: [{ id: "tier-default", type: "tier", title: "Default", emoji: "📋", color: "rgb(99, 102, 241)", collapsed: false, items: [] }]
  });

  await transaction(async (client: any) => {
    // Reset layout_config and auto_sort
    await client.query('UPDATE profiles SET layout_config = $1, auto_sort = NULL WHERE id = $2', [baselineLayout, profileId]);

    // Copy models priority/enabled from fallback_config
    await client.query('DELETE FROM profile_models WHERE profile_id = $1', [profileId]);
    const rows = await client.query(
      'SELECT model_db_id, priority, enabled FROM fallback_config ORDER BY priority ASC',
    );
    for (const m of rows.rows) {
      await client.query(
        'INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES ($1, $2, $3, $4)',
        [profileId, m.model_db_id, m.priority, m.enabled],
      );
    }
  });

  const updated = await query(
    'SELECT id, name, emoji, color, type, is_favorite, sort_order, auto_sort, layout_config, auto_include_new_models, created_at FROM profiles WHERE id = $1',
    [profileId],
  );
  res.json(updated.rows[0]);
});

// DELETE /api/profiles/:id — delete a profile
profilesRouter.delete('/:id', async (req: Request, res: Response) => {
  const profileId = getId(req);
  const profile = await rowOr404(
    res,
    'SELECT id, type FROM profiles WHERE id = $1',
    [profileId],
    'Profile',
  );
  if (!profile) return;
  if (profile.type === 'default' || profile.type === 'builtin') {
    res.status(400).json({ error: { message: 'Cannot delete the default profile' } });
    return;
  }
  const count = (await query('SELECT COUNT(*) as cnt FROM profiles')).rows[0] as { cnt: number };
  if (Number(count.cnt) <= 1) {
    res.status(400).json({ error: { message: 'Cannot delete the last profile' } });
    return;
  }

  // If the deleted profile is the currently active one, switch to Default
  const activeResult = await query(`SELECT value FROM settings WHERE key = 'active_profile_id'`);
  const activeRow = activeResult.rows[0] as { value: string } | undefined;
  const activeId = activeRow ? parseInt(activeRow.value) : null;

  await query('DELETE FROM profiles WHERE id = $1', [profileId]);

  if (activeId === profileId) {
    const defaultProf = await query(
      "SELECT id FROM profiles WHERE type = 'default' OR type = 'builtin' ORDER BY id ASC LIMIT 1",
    );
    let fallbackId = defaultProf.rows[0]?.id;
    if (!fallbackId) {
      const first = await query('SELECT id FROM profiles ORDER BY sort_order ASC LIMIT 1');
      fallbackId = first.rows[0]?.id;
    }
    if (fallbackId) {
      await query(
        `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ['active_profile_id', String(fallbackId)],
      );
    }
  }

  res.json({ success: true });
});

// POST /api/profiles/:id/sort/:preset — sort models in a profile by a preset
const SORT_PRESETS: Record<string, string> = {
  intelligence: 'm.intelligence_rank ASC',
  speed: 'm.speed_rank ASC',
};

async function sortProfileModels(db: any, profileId: number, preset: string) {
  let models: { id: number }[] = [];

  if (preset === 'budget') {
    const allModels = await query(`SELECT id, monthly_token_budget, tpd_limit FROM models`);
    allModels.rows.sort((a: any, b: any) => monthlyBudgetScore(b) - monthlyBudgetScore(a));
    models = allModels.rows.map((m: any) => ({ id: m.id }));
  } else {
    const orderBy = SORT_PRESETS[preset];
    if (!orderBy) {
      throw new Error(`Unknown preset: ${preset}. Use: intelligence, speed, budget`);
    }
    models = (await query(`SELECT m.id FROM models m ORDER BY ${orderBy}`)).rows as { id: number }[];
  }

  // Preserve existing enabled flags so sorting doesn't reset disabled models
  const existing = await query(
    `SELECT model_db_id, enabled FROM profile_models WHERE profile_id = $1`,
    [profileId],
  );
  const enabledMap = new Map(existing.rows.map((e: any) => [e.model_db_id, e.enabled]));

  await transaction(async (client: any) => {
    await client.query('DELETE FROM profile_models WHERE profile_id = $1', [profileId]);
    const insert = `INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES ($1, $2, $3, $4)`;
    for (let i = 0; i < models.length; i++) {
      // Use existing enabled state if available, default to 1 for newly added models
      const enabled = enabledMap.has(models[i].id) ? enabledMap.get(models[i].id) : 1;
      await client.query(insert, [profileId, models[i].id, i + 1, enabled]);
    }
  });
}

profilesRouter.post('/:id/sort/:preset', async (req: Request, res: Response) => {
  const profileId = getId(req);
  const profile = await rowOr404(
    res,
    'SELECT id FROM profiles WHERE id = $1',
    [profileId],
    'Profile',
  );
  if (!profile) return;

  const preset = String(req.params.preset);

  try {
    await sortProfileModels(getDb(), profileId, preset);
    res.json({ success: true, preset });
  } catch (error: any) {
    res.status(400).json({ error: { message: error.message } });
  }
});

// Initialize built-in profiles if they don't exist
export async function seedProfiles(): Promise<void> {
  const count = (await query("SELECT COUNT(*) as cnt FROM profiles WHERE type = 'default' OR type = 'builtin'")).rows[0] as { cnt: number };
  if (Number(count.cnt) > 0) return;

  const builtins: Array<{
    name: string;
    emoji: string;
    color: string;
    profileType: string;
    modelScores: Array<{ namePattern: string; score: number }>;
  }> = [
    {
      name: 'Default',
      emoji: '⭐',
      color: '#6366f1',
      profileType: 'default',
      modelScores: [
        { namePattern: 'gpt-4o', score: 3 },
        { namePattern: 'qwen3-coder', score: 2 },
        { namePattern: 'gemini', score: 1 },
      ],
    }
  ];

  await transaction(async (client: any) => {
    for (const builtin of builtins) {
      const result = await client.query(
        'INSERT INTO profiles (name, emoji, color, type, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [builtin.name, builtin.emoji, builtin.color, builtin.profileType, -1],
      );
      const profileId = Number(result.rows[0].id);

      const models = await client.query('SELECT id, LOWER(display_name) as name FROM models ORDER BY id ASC');
      const scored = models.rows.map((m: any) => {
        let score = 0;
        for (const s of builtin.modelScores) {
          if (m.name.includes(s.namePattern)) {
            score = s.score;
            break;
          }
        }
        return { ...m, score };
      });

      scored.sort((a: any, b: any) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.name.localeCompare(b.name);
      });

      for (let i = 0; i < scored.length; i++) {
        await client.query(
          'INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES ($1, $2, $3, $4)',
          [profileId, scored[i].id, i + 1, 1],
        );
      }

      // Set the default active profile
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ['active_profile_id', String(profileId)],
      );
    }
  });

  console.log(`Seeded Default profile`);
}
