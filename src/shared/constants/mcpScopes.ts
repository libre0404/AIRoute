/**
 * MCP Authorization Scopes — Defines permission scopes for each MCP tool.
 *
 * Each tool requires specific scopes to execute. API keys can be configured
 * with a subset of scopes to limit tool access (least-privilege).
 */

// ============ Scope Definitions ============

/** All available MCP scopes */
export const MCP_SCOPE_LIST = [
  "read:health",
  "read:combos",
  "write:combos",
  "read:quota",
  "read:usage",
  "read:models",
  "execute:completions",
  "execute:search",
  "write:budget",
  "write:resilience",
  "pricing:write",
  "read:cache",
  "write:cache",
  "read:compression",
  "write:compression",
  "read:proxies",
] as const;

export type McpScope = (typeof MCP_SCOPE_LIST)[number];

// ============ Tool → Scope Mapping ============

/** Maps each MCP tool to its required scopes */
export const MCP_TOOL_SCOPES: Record<string, readonly McpScope[]> = {
  // Phase 1: Essential Tools
  AIRoute_get_health: ["read:health"],
  AIRoute_list_combos: ["read:combos"],
  AIRoute_get_combo_metrics: ["read:combos"],
  AIRoute_switch_combo: ["write:combos"],
  AIRoute_check_quota: ["read:quota"],
  AIRoute_route_request: ["execute:completions"],
  AIRoute_web_search: ["execute:search"],
  AIRoute_web_fetch: ["execute:search"],
  AIRoute_cost_report: ["read:usage"],
  AIRoute_list_models_catalog: ["read:models"],

  // Phase 2: Advanced Tools
  AIRoute_simulate_route: ["read:health", "read:combos"],
  AIRoute_set_budget_guard: ["write:budget"],
  AIRoute_set_resilience_profile: ["write:resilience"],
  AIRoute_test_combo: ["execute:completions", "read:combos"],
  AIRoute_get_provider_metrics: ["read:health"],
  AIRoute_best_combo_for_task: ["read:combos", "read:health"],
  AIRoute_explain_route: ["read:health", "read:usage"],
  AIRoute_get_session_snapshot: ["read:usage"],
  AIRoute_db_health_check: ["read:health", "write:resilience"],
  AIRoute_sync_pricing: ["pricing:write"],
  AIRoute_cache_stats: ["read:cache"],
  AIRoute_cache_flush: ["write:cache"],
  AIRoute_compression_status: ["read:compression"],
  AIRoute_compression_configure: ["write:compression"],
  AIRoute_set_compression_engine: ["write:compression"],
  AIRoute_list_compression_combos: ["read:compression"],
  AIRoute_compression_combo_stats: ["read:compression"],
  AIRoute_oneproxy_fetch: ["read:proxies"],
  AIRoute_oneproxy_rotate: ["read:proxies"],
  AIRoute_oneproxy_stats: ["read:proxies"],

  // Web-session pool observability (read) + lifecycle (write)
  AIRoute_pool_status: ["read:health"],
  AIRoute_pool_sessions: ["read:health"],
  AIRoute_pool_health: ["read:health"],
  AIRoute_pool_reset: ["write:resilience"],
  AIRoute_pool_warm: ["write:resilience"],
  // Stealth browser pool observability (#3368 PR7)
  AIRoute_browser_pool_status: ["read:health"],
} as const;
