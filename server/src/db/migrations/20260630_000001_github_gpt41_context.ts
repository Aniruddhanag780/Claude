import type { Db } from '../types.js';

/**
 * GitHub Models' free GPT-4.1 endpoint rejects requests above the low-tier
 * per-call input cap even though the upstream model can support a larger
 * context elsewhere. Keep the local catalog aligned with the routable limit.
 */
export async function up(db: Db): Promise<void> {
  await db.run(`
    UPDATE models
       SET context_window = 8000
     WHERE platform = 'github'
       AND model_id = 'openai/gpt-4.1'
  `);
}

export async function down(db: Db): Promise<void> {
  await db.run(`
    UPDATE models
       SET context_window = 128000
     WHERE platform = 'github'
       AND model_id = 'openai/gpt-4.1'
  `);
}
