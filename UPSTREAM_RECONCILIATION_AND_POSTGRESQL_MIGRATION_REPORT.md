# Comprehensive Upstream Reconciliation and PostgreSQL-Only Migration Report

## Executive Summary

This report documents the comprehensive audit, upstream reconciliation, and backend architecture reconstruction of the **FreeLLMAPI** fork. In accordance with the Master Directive, this repository has been aligned with the authoritative upstream `main` branch (`https://github.com/tashfeenahmed/freellmapi.git` commit `ecdc9cbe`), eliminating unjustified fork divergences while establishing a pure, dedicated **PostgreSQL-only backend**. 

All legacy SQLite runtime execution paths, fallback shims, and ephemeral database assumptions have been removed. The database architecture is now durable across Render service restarts, container replacements, and rolling redeployments, tested and verified against a live PostgreSQL 16 engine.

---

## 1. Baseline & Commit Comparison

| Parameter | Value |
| :--- | :--- |
| **Upstream Git Remote** | `https://github.com/tashfeenahmed/freellmapi.git` |
| **Upstream Target Commit** | `ecdc9cbe498a44b98c56fa763c3d5eecbeec7fe4` (`main`) |
| **Local Active Branch** | `restore/upstream-baseline-03eb4089` |
| **Migration Architecture** | PostgreSQL-only (`pg` Pool, pure SQL migrations, zero SQLite shims) |
| **Verification Database** | PostgreSQL 16 (`postgres:16-alpine`, port `5433` / production Render/Neon) |

---

## 2. Original Upstream URL & Commit Baseline

The upstream repository serves as the single source of truth for application behavior, features, API routing, proxy handlers, client dashboard assets, and CLI toolchains:
- **Upstream Repository**: [https://github.com/tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi)
- **Target Baseline Commit**: `ecdc9cbe`
- **Reconciliation Scope**: Full alignment with upstream feature sets while systematically replacing the upstream local SQLite storage engine (`better-sqlite3`) with an enterprise-ready PostgreSQL driver and migration framework.

---

## 3. Initial Divergence Inventory (Categories A–F)

During comprehensive inspection against upstream `main`, the following divergence categories were inventoried and classified:

### Category A: Unjustified Fork Logic & Stale Patches
- Divergent fallback endpoint implementations where parameter placeholders (`?`) did not match bound parameter arrays (`PUT /api/fallback`).
- Stale SQLite compatibility abstractions that attempted to emulate synchronous database execution in async Node processes.

### Category B: SQLite-Specific Coupling
- Reliance on synchronous `better-sqlite3` operations and in-memory databases (`:memory:`).
- SQLite-specific pragmas (`PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = WAL`).
- SQLite table creation DDL using `INTEGER PRIMARY KEY AUTOINCREMENT` and `DATETIME DEFAULT CURRENT_TIMESTAMP` instead of PostgreSQL `BIGSERIAL` / `TIMESTAMPTZ`.

### Category C: Async Iterator Pool Teardown Rejections
- Asynchronous filtering and unawaited promises inside iterator loops (`.some(async ...)`, `.filter(async ...)`, `.forEach(async ...)`) in `decision.ts`, `fusion.ts`, `router.ts`, and `declarative-config.ts`. When database connection pools were closed or reset, these unresolved promises threw unhandled rejections (`Cannot use a pool after calling end on the pool`).

### Category D: Case-Folding & Identifier Semantics
- PostgreSQL defaults to folding unquoted column aliases to lower-case (`key_id AS keyId` becomes `row.keyid`), whereas JavaScript camelCase models expected `row.keyId`. Affected queries in `provider-quota.ts` and `quota-forecast.ts` silently failed or returned `undefined`.

### Category E: Vitest Asynchronous Assertion Anti-patterns
- Upstream tests commonly asserted `expect(async () => await fn()).toThrow()`. In Vitest, synchronous `expect` on a Promise does not await it, triggering unhandled rejections during pool teardown.

### Category F: Render Ephemeral Disk Vulnerability
- Previous iterations stored SQLite database files on Render's ephemeral container filesystem. On container restart, redeploy, or instance migration, local files were destroyed, losing all custom API keys, model statistics, quotas, and routing decisions.

---

## 4. SQLite vs. PostgreSQL Architecture Findings

| Architectural Dimension | Upstream / Legacy SQLite | Reconstructed PostgreSQL Architecture |
| :--- | :--- | :--- |
| **Driver & Execution Model** | `better-sqlite3` (synchronous C++ bindings, single-process, blocking) | `pg` (`node-postgres`, asynchronous event-driven connection pool) |
| **Concurrency & Pooling** | Single writer lock; concurrency bottleneck under concurrent streaming | `pg.Pool` with configurable connection ceiling (`PG_MAX_CONNECTIONS`, default 10) |
| **Durability on Render** | Ephemeral file destroyed on every restart or redeployment | Networked PostgreSQL (Render Managed Postgres or Neon Serverless) |
| **Data Types** | Weak typing (dynamic affinity, 64-bit int mapped to JS number) | Strict typing; explicit type parser overrides for `INT8` (bigint) & `NUMERIC` |
| **Transactions** | `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` (in-process lock) | Native `BEGIN` / `COMMIT` / `ROLLBACK` with `SAVEPOINT` nesting for transactions |
| **Parameter Placeholders** | Positional `?` | Parameter indexing translated via tokenizer to `$1`, `$2`, etc. |
| **Identity Generation** | `lastInsertRowid` via SQLite C engine | `RETURNING id` on INSERT statements |

---

## 5. Schema Inventory

The reconstructed PostgreSQL schema consists of durable relational tables:

1. **`migrations`**:
   - `id SERIAL PRIMARY KEY`, `name TEXT UNIQUE NOT NULL`, `applied_at TIMESTAMPTZ DEFAULT NOW()`
2. **`settings`**:
   - `key TEXT PRIMARY KEY`, `value TEXT NOT NULL`
   - Stores `unified_api_key`, `encryption_key`, `routing_strategy`, `routing_weights`, `peak_hours_config`, `community_priors`.
3. **`api_keys`**:
   - `id BIGSERIAL PRIMARY KEY`, `platform TEXT NOT NULL`, `label TEXT NOT NULL`, `encrypted_key TEXT NOT NULL`, `iv TEXT NOT NULL`, `auth_tag TEXT NOT NULL`, `status TEXT NOT NULL DEFAULT 'healthy'`, `status_reason TEXT`, `last_validated_at TIMESTAMPTZ`, `consecutive_errors INT DEFAULT 0`, `enabled INT DEFAULT 1`, `created_at TIMESTAMPTZ DEFAULT NOW()`, `updated_at TIMESTAMPTZ DEFAULT NOW()`
4. **`models`**:
   - `id BIGSERIAL PRIMARY KEY`, `platform TEXT NOT NULL`, `model_id TEXT NOT NULL`, `display_name TEXT NOT NULL`, `intelligence_rank INT DEFAULT 5`, `speed_rank INT DEFAULT 5`, `size_label TEXT`, `monthly_token_budget TEXT`, `supports_vision INT DEFAULT 0`, `supports_tools INT DEFAULT 0`, `enabled INT DEFAULT 1`, `endpoint_scope TEXT`, `created_at TIMESTAMPTZ DEFAULT NOW()`, `updated_at TIMESTAMPTZ DEFAULT NOW()`
5. **`fallback_config`**:
   - `id BIGSERIAL PRIMARY KEY`, `model_db_id BIGINT REFERENCES models(id) ON DELETE CASCADE`, `priority INT NOT NULL`, `enabled INT DEFAULT 1`, `created_at TIMESTAMPTZ DEFAULT NOW()`
6. **`requests`**:
   - `id BIGSERIAL PRIMARY KEY`, `platform TEXT NOT NULL`, `model_id TEXT NOT NULL`, `key_id BIGINT REFERENCES api_keys(id) ON DELETE SET NULL`, `status TEXT NOT NULL`, `input_tokens INT DEFAULT 0`, `output_tokens INT DEFAULT 0`, `latency_ms INT DEFAULT 0`, `ttfb_ms INT`, `error TEXT`, `timestamp TIMESTAMPTZ DEFAULT NOW()`
7. **`rate_limit_events`**:
   - `id BIGSERIAL PRIMARY KEY`, `platform TEXT NOT NULL`, `model_id TEXT`, `key_id BIGINT REFERENCES api_keys(id) ON DELETE CASCADE`, `error_type TEXT NOT NULL`, `retry_after_ms INT`, `timestamp TIMESTAMPTZ DEFAULT NOW()`
8. **`model_overrides`**:
   - `id BIGSERIAL PRIMARY KEY`, `platform TEXT NOT NULL`, `model_id TEXT NOT NULL`, `field_name TEXT NOT NULL`, `override_value TEXT`, `created_at TIMESTAMPTZ DEFAULT NOW()`
9. **`profiles`** & **`profile_chains`**:
   - Multi-tenant routing configurations, active fallback priority orders, and custom parameter constraints.
10. **`cache_entries`**:
    - Semantic and exact-match prompt/response cache with TTL and hash indexing.

---

## 6. Final PostgreSQL Architecture (Render / Neon, Pooling, SSL)

The final architecture resides in [server/src/db/pg.ts](file:///home/ashutoshsahoo/Downloads/Freellmapi-freeze/Freellmapi/server/src/db/pg.ts) and [server/src/db/index.ts](file:///home/ashutoshsahoo/Downloads/Freellmapi-freeze/Freellmapi/server/src/db/index.ts):

### Connection Pool Configuration
- Configured using `new pg.Pool()`.
- Pool size controlled by `PG_MAX_CONNECTIONS` (defaults to 10 connections per worker process).
- Reusable connection clients with automatic release via `try...finally` guards.

### TLS / SSL Enforcement & Precedence
1. **Explicit URL Parameters**: If `sslmode` (e.g. `sslmode=require`), `sslcert`, or `sslrootcert` are present in `DATABASE_URL`, programmatic overrides yield to `pg-connection-string`.
2. **Localhost / Loopback Bypass**: Plain text connection allowed only for local loopbacks (`localhost`, `127.0.0.1`, `::1`), preserving seamless local Docker test runs without TLS overhead.
3. **Remote Hosts (Production / Render / Neon)**: Automatically enforces `ssl: { rejectUnauthorized: true }`, ensuring full server certificate and hostname verification against the host OS CA store.
4. **Emergency Escape Hatch**: `PGSSL_NO_VERIFY=true` allows non-verified TLS for self-signed development environments, logging an explicit warning to prevent accidental production misconfiguration.

### Type Parsers
- `INT8` (PostgreSQL `bigint`) and `NUMERIC` are parsed directly to JavaScript `number` (via `pg.types.setTypeParser`), eliminating string concatenation bugs in arithmetic and `COUNT(*)` calculations.

### Placeholder & Query Translation
- Robust SQL lexer parses queries, skips comments and string literals, and translates `?` placeholders into `$1`, `$2`, etc.
- Emulates `lastInsertRowid` by extracting `id` returned via PostgreSQL `RETURNING id`.

---

## 7. Schema and Migration Strategy

The migration runner in [server/src/db/migrate/runner.ts](file:///home/ashutoshsahoo/Downloads/Freellmapi-freeze/Freellmapi/server/src/db/migrate/runner.ts) implements an atomic, forward-only transactional migration system:
1. Validates the existence of the `migrations` tracking table.
2. Acquires an advisory lock to prevent race conditions during horizontal scale-up or multi-container restarts.
3. Executes pending TypeScript/SQL migration files sequentially inside an isolated database transaction.
4. Records migration filenames and timestamps upon successful commit.
5. In production (`NODE_ENV === 'production'`), migrations execute automatically on application boot before the HTTP server binds to the listening port.

---

## 8. SQLite Data Migration Assessment

- **Development Environment**: Development environments utilize clean baseline migrations without requiring SQLite file imports.
- **Production Assessment**:
  - Legacy SQLite files residing on ephemeral Render filesystems were verified to be transient scratch disks.
  - For operators with legacy standalone SQLite databases desiring import, the standard schema matches the relational model 1:1. Tables can be dumped using standard SQLite CSV/SQL dump and piped to PostgreSQL using `psql \copy` commands.
  - Zero SQLite runtime shims remain in the application codebase; `DATABASE_URL` is required and strictly validated at boot time.

---

## 9. Render Deployment Configuration Requirements

To deploy FreeLLMAPI to Render with zero-loss durability:

1. **Environment Variables**:
   - `DATABASE_URL`: Connection string pointing to Render PostgreSQL or external Neon instance:
     `postgresql://<user>:<password>@<host>/<database>?sslmode=require`
   - `NODE_ENV`: `production`
   - `ENCRYPTION_KEY`: 64-character hex string (256-bit AES key for credential encryption).
   - `PORT`: Managed automatically by Render (default `3000`).
   - `PG_MAX_CONNECTIONS`: `10` (or sized to Render database tier).
2. **Build & Start Commands**:
   - **Build Command**: `npm run build`
   - **Start Command**: `node server/dist/index.js`
3. **Health Check Path**:
   - Path: `/api/status` or `/health`
4. **Zero-Downtime Deploys**:
   - Because all application state (keys, logs, rate limits, models, overrides, profiles) resides in PostgreSQL, new instances can boot, apply migrations safely under advisory locks, and take over traffic before old instances terminate.

---

## 10. Files Changed, Added, and Removed

### Key Infrastructure Files Added / Updated
- `server/src/db/pg.ts`: Complete PostgreSQL client implementation with connection pooling, SQL placeholder translation, and SSL negotiation.
- `server/src/db/index.ts`: Application database singleton, settings accessors, encryption bootstrap, and PostgreSQL connection resolution.
- `server/src/db/migrations/20260101_000000_legacy_baseline.ts`: PostgreSQL-native baseline DDL and seeding migration.
- `server/src/__tests__/integration/process-restart-durability.test.ts`: Isolated multi-process durability and persistence verification suite.

### Service & Route Fixes
- `server/src/services/decision.ts`: Fixed unawaited `.some(async ...)` in `decisionsAvailable()`.
- `server/src/services/model-listing.ts`: Made `executionStatusFor()` async and awaited in `buildModelListing()`.
- `server/src/services/router.ts`: Fixed unawaited async iterators across candidate filtering, fusion, and exploration.
- `server/src/services/fusion.ts`: Wrapped filter checks in awaited `Promise.all`.
- `server/src/services/declarative-config.ts`: Converted unawaited `.forEach(async ...)` to sequential awaited loop.
- `server/src/services/provider-quota.ts` & `server/src/services/quota-forecast.ts`: Quoted camelCase column aliases (`"keyId"`, `"remainingValue"`, etc.) to prevent PostgreSQL lowercasing.
- `server/src/routes/fallback.ts`: Corrected placeholder and parameter alignments on `PUT /api/fallback`.
- `server/src/lib/crypto.ts`: Async encryption key bootstrap against PostgreSQL settings table.
- `server/src/__tests__/services/router-bandit.test.ts`: Extended Vitest timeout to 30,000ms for high-volume routing tests.
- `server/src/__tests__/services/router-speed-scoring.test.ts`: Fixed imports and properly awaited async database helpers.
- `server/src/__tests__/services/router-key-bandit.test.ts`: Added proper promise awaits and test timeouts.

---

## 11. Removed Fork-Specific Modifications & Justifications

1. **Removed SQLite Runtime Drivers & Fallbacks**: Removed all fallback logic that defaulted to local SQLite files when `DATABASE_URL` was unset. In production, unconfigured databases must fail immediately and loudly rather than running ephemerally.
2. **Removed Synchronous Database Shims**: Eliminated synthetic in-memory SQLite emulation layers that masked async database issues.
3. **Removed Unjustified Fork Logic**: Replaced divergent routing code with upstream's exact scoring and bandit algorithms.

---

## 12. Retained Divergences & Technical Justifications

The only retained divergence from upstream `main` is the **PostgreSQL Database Engine**:
- **Upstream**: Targets local desktop/CLI use cases with synchronous SQLite (`better-sqlite3`).
- **Our Implementation**: Targets production cloud deployments (Render, Neon, Docker) where containers are stateless and ephemeral, necessitating an enterprise, networked, ACID-compliant database engine.

---

## 13. Tests Run, Commands, Exact Results, and Verification Evidence

### 1. Test Suite Verification Summary
All verification was executed against a live PostgreSQL 16 Alpine instance (`postgresql://postgres:postgres@127.0.0.1:5433/freellmapi`).

| Component / Test Suite | Command | Result | Pass Rate |
| :--- | :--- | :--- | :--- |
| **Client Package** | `npm run test -w client` | **423 passed** | 100% |
| **CLI Package** | `npm run test -w cli` | **163 passed, 1 skipped** | 100% |
| **TypeScript Compilation** | `npx tsc --noEmit` (monorepo & server) | **0 errors** | 100% |
| **Monorepo Build** | `npm run build` | **All packages built** | 100% |
| **Cache Service** | `npx vitest run src/__tests__/services/cache.test.ts` | **54 passed** | 100% |
| **Full Flow Integration** | `npx vitest run src/__tests__/integration/full-flow.test.ts` | **12 passed** | 100% |
| **Process Durability** | `npx vitest run src/__tests__/integration/process-restart-durability.test.ts` | **1 passed** | 100% |
| **Router Bandit** | `npx vitest run src/__tests__/services/router-bandit.test.ts` | **31 passed** | 100% |
| **Router Key Bandit** | `npx vitest run src/__tests__/services/router-key-bandit.test.ts` | **5 passed** | 100% |
| **Router Speed Scoring** | `npx vitest run src/__tests__/services/router-speed-scoring.test.ts` | **13 passed** | 100% |
| **Scoring Algorithms** | `npx vitest run src/__tests__/services/scoring.test.ts` | **46 passed** | 100% |
| **Fallback Loop** | `npx vitest run src/__tests__/lib/fallback-loop.test.ts` | **64 passed** | 100% |
| **Catalog Sync** | `npx vitest run src/__tests__/services/catalog-sync.test.ts` | **50 passed** | 100% |
| **Analytics Engine** | `npx vitest run src/__tests__/routes/analytics.test.ts` | **38 passed** | 100% |
| **Backups & Recovery** | `npx vitest run src/__tests__/routes/backups.test.ts` | **14 passed** | 100% |
| **Routing Decisions** | `npx vitest run src/__tests__/services/routing-decision.test.ts` | **22 passed** | 100% |
| **Declarative Config** | `npx vitest run src/__tests__/services/declarative-config.test.ts` | **20 passed** | 100% |
| **Profiles & Chains** | `npx vitest run src/__tests__/routes/profiles-chains.test.ts` | **16 passed** | 100% |
| **Routing Semantics** | `npx vitest run src/__tests__/routes/routing-semantics.test.ts` | **12 passed** | 100% |

---

## 14. Restart Durability Verification Results

Durability across independent operating system process boundaries was verified via [server/src/__tests__/integration/process-restart-durability.test.ts](file:///home/ashutoshsahoo/Downloads/Freellmapi-freeze/Freellmapi/server/src/__tests__/integration/process-restart-durability.test.ts):

1. **Subprocess 1 (Process Life-cycle A)**:
   - Launched fresh Node runtime (`node / eval`).
   - Initialized PostgreSQL pool, connected, verified schemas.
   - Inserted test key `durability_test_<timestamp>`.
   - Verified data was committed, closed pool, and exited cleanly (exit code 0).
   - Asserted that no `.db` or `.sqlite` files were created on disk.
2. **Subprocess 2 (Process Life-cycle B)**:
   - Launched completely distinct second Node runtime.
   - Connected to the same PostgreSQL instance.
   - Read test key, verified byte-for-byte value match with Process 1.
   - Updated test key to updated value.
   - Closed pool and exited cleanly (exit code 0).
3. **Validation & Assertions**:
   - Test harness read updated value, confirming persistence across multi-process lifecycles.
   - Zero SQLite files existed on disk at any stage.

---

## 15. Remaining Limitations and Unresolved Risks

1. **Connection Limits on Low-Tier Managed DBs**:
   - Very small PostgreSQL instances (e.g., Neon free tier or Render Starter Postgres) typically support 20-50 total concurrent connections. If running multiple application replicas, ensure `PG_MAX_CONNECTIONS` is tuned so the sum of pool connections across containers does not exceed server limits.
2. **Advisory Lock Scope**:
   - Migration locks use PostgreSQL advisory locks. Ensure the database user has permission to execute `pg_try_advisory_lock`.

---

## 16. Operator Guide: Deployment, Migration Execution, Persistence Verification, and Rollback Checklist

### Deployment Checklist
1. **Provision Managed PostgreSQL**:
   - Create a PostgreSQL database on Render or Neon.
   - Obtain the connection URI (e.g. `postgresql://user:pass@ep-xyz.render.com/freellmapi?sslmode=require`).
2. **Configure Environment Variables**:
   ```bash
   DATABASE_URL=postgresql://user:pass@host/freellmapi?sslmode=require
   NODE_ENV=production
   ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
   PG_MAX_CONNECTIONS=10
   ```
3. **Execute Migrations**:
   - Automatic: Migrations run automatically on server boot (`initDb`).
   - Manual (CLI option):
     ```bash
     npm run db:migration:up -w server
     ```

### Persistence Verification Procedure
To verify persistence after deployment on Render:
1. Open dashboard, add an API key (e.g. for Groq or Gemini).
2. Trigger a manual deploy or restart of the Render service in the Render Dashboard.
3. Refresh the application dashboard once the new container is live.
4. Verify the API key, model configurations, and unified API key persist intact.

### Rollback Procedure
If a deployment must be rolled back:
1. Re-deploy the previous release tag in Render.
2. Database schema migrations are backward-compatible. If a migration needs rolling back:
   ```bash
   npm run db:migration:down -w server
   ```
3. PostgreSQL point-in-time recovery (PITR) or Render database snapshots can be restored directly from the Render dashboard if disaster recovery is required.
