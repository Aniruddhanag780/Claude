import { providerHttpError, type KeyValidationResult } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';

export const ONOMEO_BASE_URL = 'https://onomeo.com/v1';

/**
 * onomeo (#1460): an OpenAI-compatible gateway whose free models share one
 * call-counted allowance — 30 calls per 5-hour window per account, with a
 * site-wide pool and a `too_fast` per-minute guard on top. Model rows are
 * published only through the signed catalog; nothing here enrolls models.
 *
 * Error vocabulary (from https://onomeo.com/integrations):
 * - 401 `bad_key` — the only authentication verdict; invalid.
 * - 403 `account_quota` / `network_quota` and 429 `site_busy` / `too_fast` —
 *   quota and throttle answers on a VALID key. Treating 403 as an invalid key
 *   (the base `validationResult` rule) would auto-disable a good key the first
 *   time its 5-hour calls run out, so those statuses stay inconclusive here.
 */
export class OnomeoProvider extends OpenAICompatProvider {
  constructor() {
    // GET /v1/models is the keyed endpoint: anonymous and bad-key callers both
    // get 401 (verified live), so it is a real credential probe.
    super({ platform: 'onomeo', name: 'onomeo', baseUrl: ONOMEO_BASE_URL, validateUrl: `${ONOMEO_BASE_URL}/models` });
  }

  protected override async validationResult(response: Response): Promise<KeyValidationResult> {
    if (response.status === 401) return super.validationResult(response);
    // 403/429 are quota/throttle verdicts on a valid key (see class docs), and
    // every other failure is an outage — all inconclusive, none key-fatal.
    if (!response.ok) throw providerHttpError(response, 'onomeo key validation is temporarily inconclusive');
    const body = await response.json().catch(() => null) as { data?: unknown; error?: unknown } | null;
    if (!Array.isArray(body?.data) || body?.error) {
      throw Object.assign(new Error('onomeo returned an invalid model list'), { status: 502 });
    }
    return true;
  }
}
