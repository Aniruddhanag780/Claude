import { z } from 'zod';
import { getDb, getSetting, setSetting } from '../db/index.js';

const SETTING_KEY = 'gemini_model_map';

export const GEMINI_FAMILIES = ['default', 'pro', 'flash', 'flashLite'] as const;
export type GeminiFamily = (typeof GEMINI_FAMILIES)[number];
export type GeminiModelMap = Record<GeminiFamily, string>;

const DEFAULT_MAP: GeminiModelMap = {
  default: 'auto',
  pro: 'auto',
  flash: 'auto',
  flashLite: 'auto',
};

const schema = z.object({
  default: z.string().min(1).optional(),
  pro: z.string().min(1).optional(),
  flash: z.string().min(1).optional(),
  flashLite: z.string().min(1).optional(),
}).strict();

export async function getGeminiModelMap(): Promise<GeminiModelMap> {
  const raw = await getSetting(SETTING_KEY);
  if (!raw) return { ...DEFAULT_MAP };
  try {
    const parsed = JSON.parse(raw) as Partial<GeminiModelMap>;
    return {
      default: parsed.default || 'auto',
      pro: parsed.pro || 'auto',
      flash: parsed.flash || 'auto',
      flashLite: parsed.flashLite || 'auto',
    };
  } catch {
    return { ...DEFAULT_MAP };
  }
}

export async function setGeminiModelMap(input: unknown): Promise<GeminiModelMap> {
  const patch = schema.parse(input);
  const current = await getGeminiModelMap();
  const next = {
    default: patch.default ?? current.default,
    pro: patch.pro ?? current.pro,
    flash: patch.flash ?? current.flash,
    flashLite: patch.flashLite ?? current.flashLite,
  };
  await setSetting(SETTING_KEY, JSON.stringify(next));
  return next;
}

export function classifyGeminiFamily(model?: string): GeminiFamily | null {
  const normalized = (model ?? '').trim().toLowerCase().replace(/^models\//, '');
  if (!normalized || normalized === 'auto') return 'default';
  if (!normalized.startsWith('gemini')) return null;
  if (/flash[-_]?lite/.test(normalized)) return 'flashLite';
  if (normalized.includes('flash')) return 'flash';
  if (normalized.includes('pro')) return 'pro';
  return 'default';
}

/**
 * Resolve a Gemini-family request to the operator's selected catalog id.
 * Returning `auto` leaves routing unpinned; concrete non-Gemini catalog ids
 * still pass through unchanged for native clients that select the gateway's
 * advertised ids.
 */
export async function resolveGeminiModel(model?: string): Promise<string> {
  const raw = (model ?? '').trim().replace(/^models\//, '');
  const family = classifyGeminiFamily(raw);
  if (family) {
    const target = await (await getGeminiModelMap())[family];
    if (!target || target === 'auto') return 'auto';
    const exists = await getDb().get('SELECT 1 FROM models WHERE model_id = ? AND enabled = 1', [target]);
    return exists ? target : 'auto';
  }
  return raw || 'auto';
}
