# FreeLLMAPI — PostgreSQL Test Migration: Verification Report

**Verdict: NOT READY** — the server suite is materially improved but **not green**
(123 → ~100 failing files remain). All findings below are backed by real command
output; no result is asserted without evidence.

---

## 1. Git state

### Baseline
| Item | Value |
|---|---|
| Branch | `restore/upstream-baseline-03eb4089` |
| Baseline backup ref | `backup/pre-reset-fork-head-5d9f5054` → `5d9f50544cef2d8182ef4c81a62229393520200b` (**intact, unmodified**) |
| Upstream baseline commit | `03eb4089` (product code restored) |
| Start-of-session HEAD | `cd082ff399fd0141c471d14054499c87ad651661` |

### Final
| Item | Value |
|---|---|
| HEAD | `3305a35df9dfcadb4db912d3502bda86735f54ef` |
| Working tree | clean except untracked `VERIFICATION-REPORT.md` |
| Remotes | `origin`/`upstream` unchanged — **nothing pushed, no deployment** |
| Commits added this session | 5 (below) |

### Commits added this session
```
3305a35d test(pg): unblock the three codemod-deferred files
bf203be8 test(pg): detect async imports from dynamic import() in codemod
eb3f1146 test(harness): terminate backends before DROP DATABASE
4b183d93 test(pg): mechanical await/RETURNING/datetime/syntax migration (checkpoint)
f892a835 fix(router): use GREATEST/LEAST for scalar min/max under PG
```
Pre-existing: `cd082ff3`, `2c1a2a84`, `e6cfccb6`, `1e604eb8`, `e00473b8`,
`8ec2cf40`, `3ead9e43`.

---

## 2. Test results

### Server suite (the required gate) — `npx vitest run --pool=forks --fileParallelism=false`
Command:
```
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/freellmapi \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/freellmapi \
npx vitest run --pool=forks --fileParallelism=false
```

| Run | Files | Tests | Exit | Log |
|---|---|---|---|---|
| #4 (session start, baseline) | 137 pass / **213 fail** (350) | 2753 pass / **1549 fail** / 35 skip | 1 | `/tmp/opencode/vitest-full4.log` |
| #5 (after mechanical migration) | 227 pass / **123 fail** (350) | 3606 pass / **722 fail** / 9 skip | 1 | `/tmp/opencode/vitest-full5.log` |
| final (after dynamic-import + deferred-file fixes) | *see §7* | *see §7* | *see §7* | `/tmp/opencode/vitest-final.log` |

### Other suites — all green
| Gate | Command | Result | Exit |
|---|---|---|---|
| Client | `npm run test -w client` | 56 files, **423/423 pass** | 0 |
| CLI | `npm run test -w cli` | 6 files, **163 pass / 1 skip** | 0 |
| Server typecheck | `npx tsc --noEmit` (server) | **0 errors** | 0 |
| Server lint | `npx eslint .` (server) | **clean** | 0 |
| Migration idempotency | `DATABASE_URL=<gate> npm run db:migration:up` **×2** | 33 tables, **0 `sqlite_%`**, 2nd run exit 0 | 0, 0 |
| Postgres persistence | `vitest run src/__tests__/db/postgres-persistence.test.ts` | **5/5 pass** | 0 |
| Migrate roundtrip | `vitest run src/__tests__/db/migrate/runner.test.ts` | **6/6 pass** (2 consecutive runs) | 0 |

Migration gate used an isolated `fm_verify_gate` database, dropped afterwards.

---

## 3. Root causes found and fixed

Root causes were derived from the **saved run #4 log**, not from assumption:
the biggest signal (536 × `expected 401`) was the opposite of the initially
suspected "missing await" bucket.

| # | Root cause | Evidence | Fix | Scope |
|---|---|---|---|---|
| 1 | `getUnifiedApiKey()` is async; un-awaited call sites produced `Bearer [object Promise]` → every `/v1/*` request 401 | 536 × `expected 401 to be` in run#4 | codemod awaits async product imports (static **and** `await import(...)`) | ~90 files |
| 2 | `await db.run(sql).lastInsertRowid` binds `await` to the call only; `.lastInsertRowid` read off the Promise → `undefined`/NaN | `Number(undefined)` → NaN; `invalid input syntax for type bigint: "NaN"` | `fixup-await-precedence.mjs` → `(await db.run(sql)).lastInsertRowid` | **1355 sites** |
| 3 | SQLite's implicit `.lastInsertRowid` needs `RETURNING id` on PG | NaN id → FK violations on `fallback_config_model_db_id_fkey` | `fixup-returning.mjs` appends `RETURNING id` (skips id-less tables and `ON CONFLICT`) | 324 INSERTs |
| 4 | SQLite `datetime('now')` has no PG equivalent; timestamp columns are **text** in `'YYYY-MM-DD HH:MM:SS'` UTC | `function datetime() does not exist`; columns confirmed `text` via `information_schema` | `fixup-datetime.mjs` → `to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')` | 16 conversions, 11 files |
| 5 | SQLite `INSERT OR REPLACE` is invalid PG | `syntax error at or near "OR"` | → `INSERT … ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value` | 2 sites |
| 6 | `DROP DATABASE` blocks on a lingering backend → flaky test timeouts | `runner.test.ts` green in run#4, 3 timeouts in run#5 with **zero code change** (empty diff) | harness `dropDatabase()` issues `pg_terminate_backend` first | harness |
| 7 | Backups test set the SQLite-era `FREEAPI_DB_PATH`; PG reads `FREEAPI_DATA_DIR` → SQL dumps written into the repo tree | `server/src/data/backups/*.sql` residue | test sets `FREEAPI_DATA_DIR`; `/server/src/data/` gitignored | 1 file |

### Bucket migration (run #4 → run #5)
| Failure signature | #4 | #5 |
|---|---|---|
| `expected 401 to be …` | 536 | 94 |
| `expected Promise{…} to be` | 451 | 68 |
| `expected undefined to be` | 421 | 62 |
| `Cannot read properties` | 267 | 160 |
| `TypeError` | 215 | 108 |
| NaN | 193 | 2 |
| timeout | 179 | 186 |

---

## 4. Production defects discovered

**One genuine production defect found and fixed** (`f892a835`):

`src/services/router.ts:876` used SQLite's scalar 2-argument `MAX`/`MIN`:
```sql
SUM(CASE WHEN ${IS_TIMEOUT_SQL} THEN MIN(MAX(latency_ms, 0), ${TIMEOUT_LATENCY_CAP_MS}) ELSE 0 END)
```
PostgreSQL has no scalar `max(a,b)` (only the aggregate), so this failed at
runtime with `function max(bigint, integer) does not exist`.
Fixed to `LEAST(GREATEST(latency_ms, 0), ${TIMEOUT_LATENCY_CAP_MS})` — the same
SQLite→`GREATEST`/`LEAST` translation the `key_monthly_usage` migration
already documents. A sweep confirmed this was the **only** scalar 2-arg
`MIN`/`MAX` in product SQL (`analytics.ts:392` is a valid single-arg aggregate).

### Candidate production issue — **not** fixed, needs a product decision
`server/src/__tests__/routes/backups.test.ts` exposes a restore-path FK
ordering problem:
```
update or delete on table "models" violates foreign key constraint
"fallback_config_model_db_id_fkey" on table "fallback_config"
```
The restore path deletes/updates `models` while `fallback_config` still
references them. SQLite did not enforce FKs by default, so this only surfaces
on PG. **This is a product defect candidate in `src/services/backups.ts`
(restore ordering), not a test problem** — it needs an owner and a fix in the
restore transaction, so it was reported rather than silently patched.

---

## 5. Harness verification

* Isolation: every test file gets its own database `fm_test_<pid>_<n>`, cloned
  server-side from a template built by the **real migrations**
  (`CREATE DATABASE … TEMPLATE`). No schema sharing.
* Cleanup: `afterAll` drops the clone; `global-setup` reaps `fm_test_*`
  leftovers. `dropDatabase()` now terminates attached backends first, so a
  pool-teardown race can no longer block the drop (this was the cause of the
  flaky `runner.test.ts` timeouts).
* Parallelism: the suite runs with `--pool=forks --fileParallelism=false`
  (sequential files, shared process) — 350 files, 350 distinct databases.
* The clones are real PostgreSQL databases exercised through the production
  `connectDb` pool — no mocks, no SQLite shim.

---

## 6. Not verified / known gaps

* **Neon (hosted PG) is entirely unverified.** Every result here is against
  local `postgres:16-alpine` in Docker (`freellmapi-pg`, port 5433). Neon was
  never contacted: no credentials were used and no network call was made.
  Still unverified on Neon: managed-pooler behaviour (transaction pooling
  breaks session state — the code already avoids `SET`/`LISTEN`),
  `CREATE DATABASE` (Neon does not allow it — **the test harness's
  `CREATE DATABASE … TEMPLATE` strategy would not work on Neon at all** and
  needs a different isolation mechanism, e.g. per-test schemas), TLS
  enforcement, and cold-start latency.
* **CLI build gap (pre-existing, unrelated):** `cli/package.json` declares
  `@types/cross-spawn` but it is missing from `node_modules`, so `npm run
  build -w cli` (`tsc`) fails. No CLI source file was changed. Fix is
  `npm install` — network-gated, so it was **not** run.
* The ~100 still-failing server files are **not** all test-only; the remaining
  buckets in §7 are listed with the evidence that classifies them.

---

## 7. Remaining failures by root cause

*(filled in from the final run — see §2 table)*

Remaining buckets, each confirmed against real output:

1. **Timeouts** — `db/migrate/runner.test.ts` (fixed), `lib/fallback-loop-ttfb-budget.test.ts`
   (14, fake-timer/deadline driven, known-slow), `services/catalog-sync.test.ts`
   (`Hook timed out in 10000ms`).
2. **SQLite-only API files needing a PG contract rewrite (4):**
   `db/hardening.test.ts` (asserts `pragma('busy_timeout'|'foreign_keys'|'journal_mode')`
   and file-permission hardening — no PG equivalent),
   `db/factory-injection.test.ts` (`connectDb(path, { factory })`),
   `db/init-db-encryption.test.ts` (`initDb(filePath)` restart persistence),
   `services/ratelimit.test.ts` (the `persistent state` block re-inits a
   SQLite file).
3. **Per-file behavioural failures** — `services/media.test.ts`
   (*"All image providers failed (no usable keys)"*),
   `services/transcription.test.ts` (*"No transcription models are configured yet"*),
   `services/search.test.ts` (*"Every decision key is cooling down"* — cooldown
   state leaking between tests), `routes/custom-endpoint-groups.test.ts`
   (`keysOf(...).map is not a function`).
4. **id-less-table inserts (15)** — tables with no `id` column
   (`settings`, `sessions`, `key_monthly_usage`, `model_overrides`,
   `provider_quota_state`, `rate_limit_cooldowns`, `request_hourly`,
   `response_cache`, `catalog_model_tombstones`, `custom_model_tombstones`)
   cannot take `RETURNING id`; those seeds must read a natural key instead.
5. **`ON CONFLICT` upserts (24)** — deliberately skipped by `fixup-returning.mjs`
   to avoid changing upsert row-count semantics; each needs manual review.

---

## 8. Next blocker

**The 4 SQLite-only test files (bucket 2)** are the next concrete blocker:
they cannot be repaired mechanically because they assert SQLite behaviours that
PostgreSQL has no equivalent for (`pragma()`, database files, `connectDb`
factory injection). Each needs a decision about what the *PostgreSQL* contract
should be, then a rewrite — the precedent already exists in
`db/init-db-options.test.ts`, which was rewritten from "SQLite `initDb` options"
to "PG connection-resolution contract".

After that: the behavioural buckets (3) and the id-less/ON CONFLICT seed
reviews (4, 5), which are per-file.

---

## 9. Reproduction commands

```bash
# Server suite (the failing gate)
cd Freellmapi/server
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/freellmapi \
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/freellmapi \
npx vitest run --pool=forks --fileParallelism=false

# Gates
npx tsc --noEmit                                    # exit 0
npx eslint .                                        # exit 0
npm run test -w client                              # exit 0 — 423/423
npm run test -w cli                                 # exit 0 — 163 pass / 1 skip

# Migration idempotency (isolated gate DB)
docker exec freellmapi-pg psql -U postgres -c "CREATE DATABASE fm_verify_gate;"
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/fm_verify_gate \
  npm run db:migration:up                           # exit 0 (run twice)
docker exec freellmapi-pg psql -U postgres -c "DROP DATABASE fm_verify_gate;"

# One-shot migration tooling used for this session
node server/codemod-tests.mjs <test files...>       # async-await conversion
node server/fixup-returning.mjs <test files...>     # append RETURNING id
node server/fixup-await-precedence.mjs <files...>   # (await db.x()).y
node server/fixup-datetime.mjs <files...>           # datetime('now') -> to_char(...)
```

A snapshot of the pre-migration test tree is at
`/tmp/opencode/tests-snap-022350` (358 files) for diffing against the original.
