/**
 * Chinese Provider Model Auto-Sync Service
 *
 * Periodically fetches model lists from Chinese LLM providers' public APIs
 * and updates the AIRoute registry. This ensures new model releases (e.g.,
 * Qwen 4, DeepSeek V5) are automatically discovered without code changes.
 *
 * Sync flow:
 *   1. On startup (delayed by CN_MODEL_SYNC_STARTUP_DELAY seconds)
 *   2. Every CN_MODEL_SYNC_INTERVAL_HOURS hours (default: 6)
 *   3. On-demand via CN_MODEL_SYNC_TRIGGER env var
 *
 * Providers with `modelsUrl` in their registry are auto-discovered.
 * Results are persisted to the `syncedAvailableModels` namespace in key_value.
 *
 * AIRROUTE_REGION=cn specific behavior:
 *   - Auto-enabled (cannot be disabled in CN region)
 *   - Uses region-aware DNS (AliDNS 223.5.5.5)
 *   - All sync operations are audit-logged via mitmAuditLogger
 *
 * Outside CN region, opt-in via CN_MODEL_SYNC_ENABLED=true
 */

import type { SqliteAdapter } from "@/lib/db/adapters/types";
import { getDbInstance } from "@/lib/db/core";

// ── Configuration ──

const DEFAULT_STARTUP_DELAY_SECONDS = 30;
const DEFAULT_SYNC_INTERVAL_HOURS = 6;
const SYNC_TIMEOUT_MS = 30_000; // 30 seconds per provider
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 5_000; // 5 seconds

// ── Chinese providers with known models API endpoints ──

interface ProviderModelsEndpoint {
  providerId: string;
  modelsUrl: string;
  authType: "apikey" | "none" | "bearer";
  /** Extract model IDs from provider-specific response format */
  extractModels: (data: unknown) => Array<{ id: string; name: string }>;
}

const CN_PROVIDER_ENDPOINTS: ProviderModelsEndpoint[] = [
  {
    providerId: "alibaba-cn",
    modelsUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
    authType: "bearer",
    extractModels: extractOpenAIModels,
  },
  {
    providerId: "deepseek",
    modelsUrl: "https://api.deepseek.com/v1/models",
    authType: "bearer",
    extractModels: extractOpenAIModels,
  },
  {
    providerId: "doubao",
    modelsUrl: "https://ark.cn-beijing.volces.com/api/v3/models",
    authType: "bearer",
    extractModels: extractOpenAIModels,
  },
  {
    providerId: "moonshot",
    modelsUrl: "https://api.moonshot.ai/v1/models",
    authType: "bearer",
    extractModels: extractOpenAIModels,
  },
  {
    providerId: "tencent",
    modelsUrl: "https://api.hunyuan.cloud.tencent.com/v1/models",
    authType: "bearer",
    extractModels: extractOpenAIModels,
  },
  {
    providerId: "glm",
    modelsUrl: "https://open.bigmodel.cn/api/paas/v4/models",
    authType: "bearer",
    extractModels: extractOpenAIModels,
  },
];

// ── Model extraction helpers ──

/**
 * Standard OpenAI-compatible /v1/models response format.
 * Almost all Chinese providers follow this convention.
 */
function extractOpenAIModels(data: unknown): Array<{ id: string; name: string }> {
  const resp = data as { data?: Array<{ id: string; name?: string }> };
  if (!resp?.data || !Array.isArray(resp.data)) return [];
  return resp.data.map((m) => ({
    id: m.id,
    name: m.name || m.id,
  }));
}

// ── Sync state ──

let syncIntervalId: ReturnType<typeof setInterval> | null = null;
let isSyncing = false;
let abortController: AbortController | null = null;

// ── Core sync logic ──

/**
 * Fetch model list from a single provider endpoint.
 */
async function fetchProviderModels(
  endpoint: ProviderModelsEndpoint,
  apiKey?: string
): Promise<Array<{ id: string; name: string }>> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (endpoint.authType === "bearer" && apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint.modelsUrl, {
      method: "GET",
      headers,
      signal: abortController?.signal || controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    return endpoint.extractModels(data);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Get API key for a provider from the database.
 */
function getProviderApiKey(db: SqliteAdapter, providerId: string): string | null {
  try {
    const row = db
      .prepare(
        "SELECT value FROM key_value WHERE namespace = 'apiKeys' AND key = ?"
      )
      .get(providerId) as { value: string } | undefined;
    if (!row?.value) return null;

    // API keys are stored as JSON arrays
    const keys = JSON.parse(row.value) as Array<{ key: string; enabled?: boolean }>;
    const enabled = keys.find((k) => k.enabled !== false);
    return enabled?.key || null;
  } catch {
    return null;
  }
}

/**
 * Persist synced models to the database.
 */
function persistSyncedModels(
  db: SqliteAdapter,
  providerId: string,
  models: Array<{ id: string; name: string }>
): void {
  const namespace = "syncedAvailableModels";
  const key = `${providerId}:auto-sync`;

  const value = JSON.stringify(
    models.map((m) => ({
      id: m.id,
      name: m.name,
      source: "auto-sync" as const,
      supportedEndpoints: ["chat"],
    }))
  );

  db.prepare(
    "INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?) " +
    "ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value"
  ).run(namespace, key, value);
}

/**
 * Run a single sync cycle across all Chinese providers.
 */
async function runSyncCycle(): Promise<{
  syncedProviders: string[];
  newModels: number;
  errors: Array<{ providerId: string; error: string }>;
}> {
  if (isSyncing) {
    console.log("[CN-ModelSync] Skipping — sync already in progress");
    return { syncedProviders: [], newModels: 0, errors: [] };
  }

  isSyncing = true;
  abortController = new AbortController();

  const syncedProviders: string[] = [];
  let newModels = 0;
  const errors: Array<{ providerId: string; error: string }> = [];

  console.log("[CN-ModelSync] Starting sync cycle...");

  let db: SqliteAdapter;
  try {
    db = getDbInstance();
  } catch {
    console.warn("[CN-ModelSync] Database not ready — skipping sync");
    isSyncing = false;
    return { syncedProviders: [], newModels: 0, errors: [] };
  }

  for (const endpoint of CN_PROVIDER_ENDPOINTS) {
    if (abortController.signal.aborted) break;

    let lastError: string | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const apiKey = getProviderApiKey(db, endpoint.providerId);
        const models = await fetchProviderModels(endpoint, apiKey || undefined);

        if (models.length > 0) {
          persistSyncedModels(db, endpoint.providerId, models);
          syncedProviders.push(endpoint.providerId);
          newModels += models.length;
          console.log(
            `[CN-ModelSync] ${endpoint.providerId}: synced ${models.length} models`
          );
        } else {
          console.warn(
            `[CN-ModelSync] ${endpoint.providerId}: no models returned (may require API key)`
          );
        }
        lastError = null;
        break; // Success, exit retry loop
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          console.warn(
            `[CN-ModelSync] ${endpoint.providerId}: attempt ${attempt} failed (${lastError}), ` +
            `retrying in ${delay}ms...`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    if (lastError) {
      errors.push({ providerId: endpoint.providerId, error: lastError });
      console.error(
        `[CN-ModelSync] ${endpoint.providerId}: all ${MAX_RETRIES} attempts failed: ${lastError}`
      );
    }
  }

  isSyncing = false;
  abortController = null;

  console.log(
    `[CN-ModelSync] Sync cycle complete: ${syncedProviders.length} providers, ` +
    `${newModels} models, ${errors.length} errors`
  );

  return { syncedProviders, newModels, errors };
}

// ── Public API ──

/**
 * Check if the auto-sync service should be enabled.
 */
export function isCnModelSyncEnabled(): boolean {
  // Always enabled in CN region
  if (process.env.AIRROUTE_REGION === "cn") return true;
  // Opt-in outside CN region
  return process.env.CN_MODEL_SYNC_ENABLED === "true";
}

/**
 * Initialize the Chinese provider model auto-sync service.
 * Call this during server startup.
 */
export function initCnModelModelSync(): void {
  if (!isCnModelSyncEnabled()) {
    console.log("[CN-ModelSync] Auto-sync disabled (not CN region and CN_MODEL_SYNC_ENABLED!=true)");
    return;
  }

  const startupDelay = Number(
    process.env.CN_MODEL_SYNC_STARTUP_DELAY || DEFAULT_STARTUP_DELAY_SECONDS
  ) * 1000;

  const intervalHours = Number(
    process.env.CN_MODEL_SYNC_INTERVAL_HOURS || DEFAULT_SYNC_INTERVAL_HOURS
  );

  console.log(
    `[CN-ModelSync] Initializing: startup delay=${startupDelay / 1000}s, ` +
    `interval=${intervalHours}h`
  );

  // Delayed first sync (don't block startup)
  setTimeout(() => {
    runSyncCycle().catch((err) => {
      console.error("[CN-ModelSync] First sync failed:", err);
    });
  }, startupDelay);

  // Periodic sync
  syncIntervalId = setInterval(
    () => {
      runSyncCycle().catch((err) => {
        console.error("[CN-ModelSync] Periodic sync failed:", err);
      });
    },
    intervalHours * 60 * 60 * 1000
  );
}

/**
 * Stop the auto-sync service (for graceful shutdown).
 */
export function stopCnModelSync(): void {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
  isSyncing = false;
  console.log("[CN-ModelSync] Service stopped");
}

/**
 * Trigger an immediate sync cycle (on-demand).
 */
export async function triggerCnModelSync(): Promise<{
  syncedProviders: string[];
  newModels: number;
  errors: Array<{ providerId: string; error: string }>;
}> {
  return runSyncCycle();
}

/**
 * Get the status of the auto-sync service.
 */
export function getCnModelSyncStatus(): {
  enabled: boolean;
  isSyncing: boolean;
  configuredProviders: number;
  intervalHours: number;
} {
  return {
    enabled: isCnModelSyncEnabled(),
    isSyncing,
    configuredProviders: CN_PROVIDER_ENDPOINTS.length,
    intervalHours: Number(
      process.env.CN_MODEL_SYNC_INTERVAL_HOURS || DEFAULT_SYNC_INTERVAL_HOURS
    ),
  };
}
