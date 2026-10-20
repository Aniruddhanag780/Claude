import pg from 'pg';
import * as initialSchema from '../migrations/001_initial_schema.js';
import * as seedProvidersModels from '../migrations/002_seed_providers_models.js';
import * as addHealthColumns from '../migrations/003_add_health_columns_to_credentials.js';
import * as fixSettingsUpdatedAt from '../migrations/004_fix_settings_updated_at.js';
import * as addMissingModelColumns from '../migrations/005_add_missing_model_columns.js';
import * as compatTables from '../migrations/006_compat_tables.js';
import * as searchAndEndpointGroup from '../migrations/007_search_and_endpoint_group.js';
import * as legacyKeyUsage from '../migrations/008_legacy_key_usage.js';
import * as seedFallbackAndDefaultProfile from '../migrations/009_seed_fallback_and_default_profile.js';
import * as modelsPlatformAndSource from '../migrations/010_models_platform_and_source.js';
import * as addProxyToCredentialsAndApiKeys from '../migrations/011_add_proxy_to_credentials_and_api_keys.js';
import * as requestAttemptsAndServedModel from '../migrations/012_request_attempts_and_served_model.js';
import * as benchmarkCatalogModels from '../migrations/013_benchmark_catalog_models.js';

export interface MigrationModule {
  up(client: pg.PoolClient | pg.Pool): Promise<void> | void;
  down(client: pg.PoolClient | pg.Pool): Promise<void> | void;
}

export interface DefaultMigration {
  filename: string;
  module: MigrationModule;
}

export const INITIAL_SCHEMA_FILENAME = '001_initial_schema.ts';
export const SEED_PROVIDERS_MODELS_FILENAME = '002_seed_providers_models.ts';
export const ADD_HEALTH_COLUMNS_FILENAME = '003_add_health_columns_to_credentials.ts';
export const FIX_SETTINGS_UPDATED_AT_FILENAME = '004_fix_settings_updated_at.ts';
export const ADD_MISSING_MODEL_COLUMNS_FILENAME = '005_add_missing_model_columns.ts';
export const COMPAT_TABLES_FILENAME = '006_compat_tables.ts';
export const SEARCH_AND_ENDPOINT_GROUP_FILENAME = '007_search_and_endpoint_group.ts';
export const LEGACY_KEY_USAGE_FILENAME = '008_legacy_key_usage.ts';
export const SEED_FALLBACK_AND_DEFAULT_PROFILE_FILENAME = '009_seed_fallback_and_default_profile.ts';
export const MODELS_PLATFORM_AND_SOURCE_FILENAME = '010_models_platform_and_source.ts';
export const ADD_PROXY_TO_CREDENTIALS_AND_API_KEYS_FILENAME = '011_add_proxy_to_credentials_and_api_keys.ts';
export const REQUEST_ATTEMPTS_AND_SERVED_MODEL_FILENAME = '012_request_attempts_and_served_model.ts';
export const BENCHMARK_CATALOG_MODELS_FILENAME = '013_benchmark_catalog_models.ts';

export const DEFAULT_MIGRATIONS: readonly DefaultMigration[] = [
  { filename: INITIAL_SCHEMA_FILENAME, module: initialSchema },
  { filename: SEED_PROVIDERS_MODELS_FILENAME, module: seedProvidersModels },
  { filename: ADD_HEALTH_COLUMNS_FILENAME, module: addHealthColumns },
  { filename: FIX_SETTINGS_UPDATED_AT_FILENAME, module: fixSettingsUpdatedAt },
  { filename: ADD_MISSING_MODEL_COLUMNS_FILENAME, module: addMissingModelColumns },
  { filename: COMPAT_TABLES_FILENAME, module: compatTables },
  { filename: SEARCH_AND_ENDPOINT_GROUP_FILENAME, module: searchAndEndpointGroup },
  { filename: LEGACY_KEY_USAGE_FILENAME, module: legacyKeyUsage },
  { filename: SEED_FALLBACK_AND_DEFAULT_PROFILE_FILENAME, module: seedFallbackAndDefaultProfile },
  { filename: MODELS_PLATFORM_AND_SOURCE_FILENAME, module: modelsPlatformAndSource },
  { filename: ADD_PROXY_TO_CREDENTIALS_AND_API_KEYS_FILENAME, module: addProxyToCredentialsAndApiKeys },
  { filename: REQUEST_ATTEMPTS_AND_SERVED_MODEL_FILENAME, module: requestAttemptsAndServedModel },
  { filename: BENCHMARK_CATALOG_MODELS_FILENAME, module: benchmarkCatalogModels },
];
