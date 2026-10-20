# BeatAPI decisions and SerpSearch

These integrations add credential and request handling only. Model/engine rows
are delivered by the signed catalog, retaining Premium access immediately and
Free access after the existing 30-day promotion gate. No bundled seeds or
release-gate changes are included.

## BeatAPI

- Add a `beatapi` key in the dashboard, or import `BEATAPI_API_KEY`.
- JEV decision requests use `POST https://api.beatapi.io/v1/systemone` with
  Bearer authentication and `{ model, state, questions }`.
- The adapter supports the existing decision question types: `choice`, `noul`,
  and `score`. It does not expose chat or JEV image-box questions.
- Validation uses authenticated `GET /v1/models`, never inference.
- `jev-1.13-free` and `jev-1.14-free` returned valid decisions in live tests on
  October 18, 2026. They are **temporary free offers**, not recurring monthly
  credits. Before any top-up they share one successful request/minute/account.
  The catalog carries these terms; a paid top-up is not required to use them.
- Response model identity and typed answers are checked. HTTP rate limits and
  stated retry hints use the existing decision router's cooldown/failover.

Sources: [decision API](https://docs.beatapi.io/decisions),
[free-model terms](https://docs.beatapi.io/free-models),
[pricing](https://beatapi.io/pricing).

## SerpSearch

- Add a `serpsearch` key under search providers, or import `SERPSEARCH_API_KEY`.
- Bearer-authenticated `GET https://api.serpsearch.com/api/v1/search?query=...`
  maps organic results to the unified search response. `topic: "news"` uses
  `/api/v1/news` and flattens article groups. It does not invent summaries or
  convert image/video search into generation models.
- The Free plan shares 1,000 requests/month across endpoints, without a card;
  live response headers confirmed the allowance and one request/second.
- Key validation is OFF for automated checks (#1599): the provider treats
  repeated empty-query requests as abuse and revokes free subscriptions for
  them, and a key sits in the pool for weeks while the health pass would run
  ~12 probes an hour. SerpSearch keys are never probed; a key is promoted to
  healthy by the first real search it serves. `validateKey` remains for
  one-off manual checks only, where the empty-query probe (valid key: 400
  missing-query with quota headers, no credit spent; invalid key: 401) is
  still the cheapest test.
- The adapter follows the existing no-hits fallback policy and result limit.
  It does not paginate automatically or consume extra credits to fill results.

Sources: [API documentation](https://serpsearch.com/docs),
[pricing](https://serpsearch.com/pricing), [FAQ](https://serpsearch.com/faq).
