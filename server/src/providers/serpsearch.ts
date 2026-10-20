import { providerHttpError, type KeyValidationResult } from './base.js';
import { SearchOnlyProvider } from './search-only.js';

export const SERPSEARCH_BASE_URL = 'https://api.serpsearch.com/api/v1';

export class SerpSearchProvider extends SearchOnlyProvider {
  readonly platform = 'serpsearch' as const;
  readonly name = 'SerpSearch';

  // #1599: SerpSearch counts empty-query requests as abuse. The probe below
  // (GET /search with no query) was the documented way to prove a key works
  // without spending quota, but the provider now revokes free subscriptions
  // for accumulated 400s — a user lost their account to our 5-minute health
  // pass. No probe is safe here, so automated validation is off entirely:
  // keys stay 'unknown' until they serve a real search and get promoted by
  // markKeyHealthyFromRequest (same seam as LLMTR, #1459).
  override get supportsKeyValidation(): boolean {
    return false;
  }

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    // Kept for callers that accept the risk (none in the health pass: it
    // short-circuits on supportsKeyValidation above). Authentication runs
    // before query validation: a valid key gets 400 with quota headers, an
    // invalid key gets 401. Do not turn this into a real search.
    const res = await this.fetchWithTimeout(`${SERPSEARCH_BASE_URL}/search`, {
      method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${apiKey}` },
    }, 10_000, { timeoutBounds: 'request' });
    if ([401, 403].includes(res.status)) return this.validationResult(res);
    const quota = res.headers.get('x-quota-limit');
    if (res.status === 400 && quota !== null && /^\d+$/.test(quota)) {
      const text = await res.text();
      if (/missing field [`'"]?query|INVALID_QUERY/i.test(text)) return true;
    }
    throw providerHttpError(res, 'SerpSearch key validation is inconclusive');
  }
}
