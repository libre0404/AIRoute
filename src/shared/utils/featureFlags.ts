import { getFeatureFlagOverride } from "@/lib/db/featureFlags";
import {
  FEATURE_FLAG_DEFINITIONS,
  type FeatureFlagDefinition,
} from "@/shared/constants/featureFlagDefinitions";

/**
 * Check if the China region mode is active (AIRROUTE_REGION=cn).
 * When true, security defaults are upgraded for PIPL compliance.
 */
export function isChinaRegion(): boolean {
  return process.env.AIRROUTE_REGION === "cn";
}

/**
 * Resolve the effective value of a feature flag.
 * Priority: DB override > process.env > definition.defaultValue
 * Special: "auto" defaults are resolved based on AIRROUTE_REGION.
 */
export function resolveFeatureFlag(key: string): string {
  const dbOverride = getFeatureFlagOverride(key);
  if (dbOverride !== undefined) return dbOverride;

  const envValue = process.env[key];
  if (envValue !== undefined && envValue !== "") return envValue;

  const definition = FEATURE_FLAG_DEFINITIONS.find((d) => d.key === key);
  const defaultValue = definition?.defaultValue ?? "false";

  // Region-aware "auto" resolution: PII flags default ON in China region
  if (defaultValue === "auto") {
    return isChinaRegion() ? "true" : "false";
  }

  return defaultValue;
}

/**
 * Check if a boolean feature flag is enabled.
 * Treats "true", "1", "yes" as enabled.
 */
export function isFeatureFlagEnabled(key: string): boolean {
  const value = resolveFeatureFlag(key);
  return value === "true" || value === "1" || value === "yes";
}

/**
 * Resolve all feature flags with their effective values and sources.
 */
export function resolveAllFeatureFlags(): Array<{
  key: string;
  effectiveValue: string;
  source: "db" | "env" | "default";
  definition: FeatureFlagDefinition;
}> {
  return FEATURE_FLAG_DEFINITIONS.map((definition) => {
    const dbOverride = getFeatureFlagOverride(definition.key);
    if (dbOverride !== undefined) {
      return { key: definition.key, effectiveValue: dbOverride, source: "db", definition };
    }
    const envValue = process.env[definition.key];
    if (envValue !== undefined && envValue !== "") {
      return { key: definition.key, effectiveValue: envValue, source: "env", definition };
    }
    return {
      key: definition.key,
      effectiveValue: definition.defaultValue,
      source: "default",
      definition,
    };
  });
}

// Backward-compatible wrappers
export function isRequireApiKeyEnabled(): boolean {
  try {
    return isFeatureFlagEnabled("REQUIRE_API_KEY");
  } catch (error) {
    console.error(
      "[featureFlags] Failed to resolve REQUIRE_API_KEY, defaulting to required:",
      error instanceof Error ? error.message : error
    );
    return true;
  }
}

export function isCcCompatibleProviderEnabled(): boolean {
  return isFeatureFlagEnabled("ENABLE_CC_COMPATIBLE_PROVIDER");
}

export function isApiKeyRevealEnabledFlag(): boolean {
  try {
    return isFeatureFlagEnabled("ALLOW_API_KEY_REVEAL");
  } catch (error) {
    console.error(
      "[featureFlags] Failed to resolve ALLOW_API_KEY_REVEAL, defaulting to disabled:",
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

export function isModelCatalogNamesEnabled(): boolean {
  return isFeatureFlagEnabled("MODEL_CATALOG_INCLUDE_NAMES");
}

export type ModelsCatalogPrefixMode = "dual" | "alias" | "canonical";

export function getModelsCatalogPrefixMode(): ModelsCatalogPrefixMode {
  const value = resolveFeatureFlag("MODELS_CATALOG_PREFIX_MODE");
  if (value === "alias" || value === "canonical") return value;
  return "dual";
}

export function isArenaEloSyncEnabled(): boolean {
  return isFeatureFlagEnabled("ARENA_ELO_SYNC_ENABLED");
}

export function isControlPlaneProxyDirectFallbackEnabled(): boolean {
  try {
    return isFeatureFlagEnabled("AIRoute_CONTROL_PLANE_PROXY_DIRECT_FALLBACK");
  } catch (error) {
    console.error(
      "[featureFlags] Failed to resolve AIRoute_CONTROL_PLANE_PROXY_DIRECT_FALLBACK, defaulting to disabled:",
      error instanceof Error ? error.message : error
    );
    return false;
  }
}
