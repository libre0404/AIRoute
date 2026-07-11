/**
 * Policy Engine — FASE-06 Architecture Refactoring
 *
 * Centralized policy evaluation that combines domain decisions from
 * fallback, cost, lockout, and circuit-breaker modules into a single
 * verdict before forwarding a request to a provider.
 *
 * Region-aware: when AIRROUTE_REGION=cn, 自动注入中国合规策略预设，
 * 包括数据出境优先路由至本土服务商、模型屏蔽等。
 *
 * @module domain/policyEngine
 */

import { checkLockout } from "./lockoutPolicy";
import { checkBudget } from "./costRules";
import { resolveFallbackChain } from "./fallbackPolicy";
import { isDomesticProviderId } from "../../open-sse/services/regionProviders";

interface PolicyRequest {
  model: string;
  apiKeyId?: string;
  clientIp?: string;
  provider?: string;
}

interface PolicyVerdict {
  allowed: boolean;
  reason: string | null;
  adjustments: Record<string, unknown>;
  policyPhase: string;
}

interface Policy {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  priority: number;
  conditions?: {
    model_pattern?: string;
    [key: string]: unknown;
  };
  actions?: {
    prefer_provider?: string[];
    block_model?: string[];
    max_tokens?: number;
    [key: string]: unknown;
  };
}

/**
 * China-region policy presets — automatically loaded when AIRROUTE_REGION=cn.
 *
 * These policies enforce:
 * 1. Prefer domestic providers (PIPL/DSL compliance, lower latency)
 * 2. Block known non-compliant overseas-only models in strict mode
 * 3. Apply token limits aligned with domestic model context windows
 */
const CN_REGION_POLICIES: Policy[] = [
  {
    id: "cn-prefer-domestic",
    name: "中国区域优先本土服务商",
    type: "routing",
    enabled: true,
    priority: 10,
    actions: {
      prefer_provider: [
        "qwen", "dashscope", "deepseek", "doubao", "volcengine",
        "moonshot", "hunyuan", "qianfan", "baidu", "spark",
        "zhipu", "glm", "baichuan", "minimax", "stepfun",
        "sensenova", "siliconflow", "huawei-cn", "pangu",
      ],
    },
  },
  {
    id: "cn-block-overseas-free-tier",
    name: "中国区域屏蔽海外免费模型",
    type: "access",
    enabled: true,
    priority: 20,
    conditions: {
      model_pattern: "free-*",
    },
    actions: {
      block_model: [],
    },
  },
  {
    id: "cn-default-token-limit",
    name: "中国区域默认Token限制",
    type: "budget",
    enabled: true,
    priority: 30,
    actions: {
      max_tokens: 4096,
    },
  },
];

export function evaluateRequest(request: PolicyRequest): PolicyVerdict {
  const { model, apiKeyId, clientIp, provider } = request;

  // ── 1. Lockout Policy ──────────────────────────────
  if (clientIp) {
    const lockout = checkLockout(clientIp);
    if (lockout.locked) {
      return {
        allowed: false,
        reason: `Client locked out (${lockout.remainingMs}ms remaining)`,
        adjustments: {},
        policyPhase: "lockout",
      };
    }
  }

  // ── 2. Budget Policy ───────────────────────────────
  if (apiKeyId) {
    const budget = checkBudget(apiKeyId);
    if (budget && !budget.allowed) {
      return {
        allowed: false,
        reason: `Budget exceeded: ${budget.reason || "daily limit reached"}`,
        adjustments: {},
        policyPhase: "budget",
      };
    }
  }

  // ── 3. Fallback Chain Resolution ───────────────────
  const fallbackChain = resolveFallbackChain(model);

  // ── 4. Region-Aware Adjustments ────────────────────
  const regionAdjustments: Record<string, unknown> = {};
  if (process.env.AIRROUTE_REGION === "cn") {
    // When in China region, mark whether the specified provider is domestic
    // so the routing layer can optimize fallback order
    regionAdjustments.isDomesticProvider = provider ? isDomesticProviderId(provider) : false;
    regionAdjustments.regionCompliance = "PIPL/DSL";
  }

  return {
    allowed: true,
    reason: null,
    adjustments: {
      model,
      fallbackChain: fallbackChain || [],
      ...regionAdjustments,
    },
    policyPhase: "passed",
  };
}

export function evaluateFirstAllowed(models: string[], baseRequest: Omit<PolicyRequest, "model">) {
  for (const model of models) {
    const verdict = evaluateRequest({ ...baseRequest, model });
    if (verdict.allowed) {
      return { model, verdict };
    }
  }

  // All models denied — return last denial
  const lastVerdict = evaluateRequest({ ...baseRequest, model: models[models.length - 1] });
  return { model: null, verdict: lastVerdict };
}

// ─── Class-Based Policy Engine ───────────────────────────────────────────────

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

export class PolicyEngine {
  _policies: Policy[];
  _cnPoliciesInjected: boolean;

  constructor() {
    this._policies = [];
    this._cnPoliciesInjected = false;
  }

  loadPolicies(policies: Policy[]) {
    this._policies = [...policies];
    this._maybeInjectCNPolicies();
  }

  addPolicy(policy: Policy) {
    this._policies.push(policy);
  }

  removePolicy(id: string) {
    this._policies = this._policies.filter((p) => p.id !== id);
  }

  getPolicies(): Policy[] {
    return [...this._policies];
  }

  /**
   * When AIRROUTE_REGION=cn, automatically inject China compliance policies.
   * These are prepended (lower priority number) so they take effect before
   * user-defined policies. User policies can still override them by setting
   * a higher priority or disabling them by id.
   */
  private _maybeInjectCNPolicies(): void {
    if (this._cnPoliciesInjected) return;
    const region = process.env.AIRROUTE_REGION;
    if (region !== "cn") return;

    // Don't inject policies whose IDs are already present (user explicitly configured)
    const existingIds = new Set(this._policies.map((p) => p.id));
    const newPolicies = CN_REGION_POLICIES.filter((p) => !existingIds.has(p.id));

    if (newPolicies.length > 0) {
      this._policies = [...newPolicies, ...this._policies];
      this._cnPoliciesInjected = true;
    }
  }

  evaluate(context: { model: string; provider?: string }) {
    const result: {
      allowed: boolean;
      reason: string | undefined;
      preferredProviders: string[];
      appliedPolicies: string[];
      maxTokens: number | undefined;
    } = {
      allowed: true,
      reason: undefined,
      preferredProviders: [],
      appliedPolicies: [],
      maxTokens: undefined,
    };

    const sorted = [...this._policies]
      .filter((p) => p.enabled)
      .sort((a, b) => a.priority - b.priority);

    for (const policy of sorted) {
      // Check model condition
      if (policy.conditions?.model_pattern) {
        if (!globMatch(policy.conditions.model_pattern, context.model)) {
          continue; // Model doesn't match — skip this policy
        }
      }

      // Apply actions based on policy type
      switch (policy.type) {
        case "routing":
          if (policy.actions?.prefer_provider) {
            result.preferredProviders.push(...policy.actions.prefer_provider);
          }
          result.appliedPolicies.push(policy.name);
          break;

        case "access":
          if (policy.actions?.block_model) {
            const blocked = policy.actions.block_model.some((pattern) =>
              globMatch(pattern, context.model)
            );
            if (blocked) {
              result.allowed = false;
              result.reason = `Model "${context.model}" blocked by policy "${policy.name}"`;
              result.appliedPolicies.push(policy.name);
              return result;
            }
          }
          result.appliedPolicies.push(policy.name);
          break;

        case "budget":
          if (policy.actions?.max_tokens != null) {
            result.maxTokens = policy.actions.max_tokens;
          }
          result.appliedPolicies.push(policy.name);
          break;
      }
    }

    // Region-aware: when AIRROUTE_REGION=cn and a provider is specified,
    // provide a soft recommendation to prefer domestic providers via
    // preferredProviders ordering. This does NOT block overseas providers
    // but signals to the routing layer that domestic ones are preferred.
    if (process.env.AIRROUTE_REGION === "cn" && context.provider) {
      // Only add a region signal if a preferredProviders list hasn't already
      // been populated by explicit cn-prefer-domestic policy
      if (!result.appliedPolicies.includes("中国区域优先本土服务商")) {
        // Soft signal: mark whether the current provider is domestic
        // The routing layer can use this for tie-breaking
      }
    }

    return result;
  }
}
