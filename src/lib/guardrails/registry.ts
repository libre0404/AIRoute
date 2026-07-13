import { BaseGuardrail, type GuardrailContext, type GuardrailExecutionResult } from "./base";
import { PIIMaskerGuardrail } from "./piiMasker";
import { PromptInjectionGuardrail } from "./promptInjection";
import { VisionBridgeGuardrail } from "./visionBridge";

type HeadersLike = Headers | Record<string, unknown> | null | undefined;

function isHeaderStore(headers: HeadersLike): headers is Headers {
  return Boolean(headers && typeof (headers as Headers).get === "function");
}

function getHeaderValue(headers: HeadersLike, name: string) {
  if (!headers) return null;
  if (isHeaderStore(headers)) return headers.get(name);

  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowered || typeof value !== "string") continue;
    return value;
  }

  return null;
}

function normalizeGuardrailName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
}

function coerceDisabledGuardrails(value: unknown) {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => normalizeGuardrailName(entry))
      .filter(Boolean);
  }

  if (!Array.isArray(value)) return [];

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => normalizeGuardrailName(entry))
    .filter(Boolean);
}

function getGuardrailLogger(context: GuardrailContext) {
  return context.log || console;
}

export function resolveDisabledGuardrails({
  apiKeyInfo,
  body,
  headers,
}: {
  apiKeyInfo?: Record<string, unknown> | null;
  body?: unknown;
  headers?: HeadersLike;
}): string[] {
  // [S-02 FIX] Only allow server-side (apiKeyInfo) guardrail disabling.
  // Previously, clients could disable guardrails via request body, metadata,
  // or HTTP headers — enabling attackers to bypass all security checks.
  // The apiKeyInfo.disabledGuardrails field is admin-controlled and safe.
  const apiKeyDisabled =
    apiKeyInfo && typeof apiKeyInfo === "object"
      ? (apiKeyInfo as Record<string, unknown>).disabledGuardrails
      : undefined;

  return [...coerceDisabledGuardrails(apiKeyDisabled)].filter(
    (value, index, list) => list.indexOf(value) === index
  );
}

export class GuardrailRegistry {
  private guardrails: BaseGuardrail[] = [];

  register(guardrail: BaseGuardrail) {
    if (!(guardrail instanceof BaseGuardrail)) {
      throw new Error("Guardrail must extend BaseGuardrail");
    }

    this.guardrails = this.guardrails.filter(
      (existing) => normalizeGuardrailName(existing.name) !== normalizeGuardrailName(guardrail.name)
    );
    this.guardrails.push(guardrail);
    this.guardrails.sort((left, right) => left.priority - right.priority);
    return guardrail;
  }

  clear() {
    this.guardrails = [];
  }

  list() {
    return [...this.guardrails];
  }

  private isDisabled(guardrail: BaseGuardrail, context: GuardrailContext) {
    const disabled = new Set(
      (context.disabledGuardrails || []).map((entry) => normalizeGuardrailName(entry))
    );
    return disabled.has(normalizeGuardrailName(guardrail.name));
  }

  async runPreCallHooks<TPayload = unknown>(payload: TPayload, context: GuardrailContext = {}) {
    const logger = getGuardrailLogger(context);
    const results: GuardrailExecutionResult[] = [];
    let currentPayload = payload;

    for (const guardrail of this.guardrails) {
      if (!guardrail.enabled || this.isDisabled(guardrail, context)) {
        results.push({
          blocked: false,
          guardrail: guardrail.name,
          modified: false,
          skipped: true,
          stage: "pre",
        });
        continue;
      }

      try {
        const result = await guardrail.preCall(currentPayload, context);
        const modified = result?.modifiedPayload !== undefined;
        const meta = result?.meta || null;

        if (modified) {
          currentPayload = result?.modifiedPayload as TPayload;
        }

        const execution: GuardrailExecutionResult = {
          blocked: result?.block === true,
          guardrail: guardrail.name,
          message: result?.message,
          meta,
          modified,
          skipped: false,
          stage: "pre",
        };
        results.push(execution);

        logger.debug?.(
          "GUARDRAIL",
          `${guardrail.name} pre-call ${execution.blocked ? "blocked" : modified ? "modified" : "passed"}`,
          meta || undefined
        );

        if (execution.blocked) {
          return {
            blocked: true,
            guardrail: guardrail.name,
            message: result?.message,
            payload: currentPayload,
            results,
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // [S-01 FIX] Fail-closed: block the request when a guardrail throws an exception.
        // Previously this was blocked:false (fail-open), allowing malicious requests to
        // bypass all security when a guardrail crashed. The guardrailOnError env var lets
        // operators opt back into fail-open if availability trumps security, but defaults
        // to "block" (fail-closed) for safety.
        const onErrorPolicy = process.env.GUARDRAIL_ON_ERROR || "block";
        const blockedOnError = onErrorPolicy !== "pass";
        results.push({
          blocked: blockedOnError,
          error: message,
          guardrail: guardrail.name,
          modified: false,
          skipped: false,
          stage: "pre",
        });
        logger.error?.(
          "GUARDRAIL",
          `${guardrail.name} pre-call ${blockedOnError ? "failed closed (blocked)" : "failed open (passed)"}`,
          { error: message, policy: onErrorPolicy }
        );
        if (blockedOnError) {
          return {
            blocked: true,
            guardrail: guardrail.name,
            message: `Security check failed: ${guardrail.name} encountered an error`,
            payload: currentPayload,
            results,
          };
        }
      }
    }

    return {
      blocked: false,
      payload: currentPayload,
      results,
    };
  }

  async runPostCallHooks<TResponse = unknown>(response: TResponse, context: GuardrailContext = {}) {
    const logger = getGuardrailLogger(context);
    const results: GuardrailExecutionResult[] = [];
    let currentResponse = response;

    for (const guardrail of this.guardrails) {
      if (!guardrail.enabled || this.isDisabled(guardrail, context)) {
        results.push({
          blocked: false,
          guardrail: guardrail.name,
          modified: false,
          skipped: true,
          stage: "post",
        });
        continue;
      }

      try {
        const result = await guardrail.postCall(currentResponse, context);
        const modified = result?.modifiedResponse !== undefined;
        const meta = result?.meta || null;

        if (modified) {
          currentResponse = result?.modifiedResponse as TResponse;
        }

        const execution: GuardrailExecutionResult = {
          blocked: result?.block === true,
          guardrail: guardrail.name,
          message: result?.message,
          meta,
          modified,
          skipped: false,
          stage: "post",
        };
        results.push(execution);

        logger.debug?.(
          "GUARDRAIL",
          `${guardrail.name} post-call ${execution.blocked ? "blocked" : modified ? "modified" : "passed"}`,
          meta || undefined
        );

        if (execution.blocked) {
          return {
            blocked: true,
            guardrail: guardrail.name,
            message: result?.message,
            response: currentResponse,
            results,
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // [S-01 FIX] Fail-closed: block the response when a post-call guardrail throws.
        // Mirrors the pre-call hook fix — previously failed open, now defaults to
        // blocking on error. Controlled by GUARDRAIL_ON_ERROR env var (same as pre-call).
        const onErrorPolicy = process.env.GUARDRAIL_ON_ERROR || "block";
        const blockedOnError = onErrorPolicy !== "pass";
        results.push({
          blocked: blockedOnError,
          error: message,
          guardrail: guardrail.name,
          modified: false,
          skipped: false,
          stage: "post",
        });
        logger.error?.(
          "GUARDRAIL",
          `${guardrail.name} post-call ${blockedOnError ? "failed closed (blocked)" : "failed open (passed)"}`,
          { error: message, policy: onErrorPolicy }
        );
        if (blockedOnError) {
          return {
            blocked: true,
            guardrail: guardrail.name,
            message: `Security check failed: ${guardrail.name} encountered an error`,
            response: currentResponse,
            results,
          };
        }
      }
    }

    return {
      blocked: false,
      response: currentResponse,
      results,
    };
  }
}

export const guardrailRegistry = new GuardrailRegistry();

let defaultGuardrailsRegistered = false;

export function registerDefaultGuardrails() {
  if (defaultGuardrailsRegistered) return guardrailRegistry;

  guardrailRegistry.register(new VisionBridgeGuardrail());
  guardrailRegistry.register(new PIIMaskerGuardrail());
  guardrailRegistry.register(new PromptInjectionGuardrail());
  defaultGuardrailsRegistered = true;

  return guardrailRegistry;
}

export function resetGuardrailsForTests({ registerDefaults = true } = {}) {
  guardrailRegistry.clear();
  defaultGuardrailsRegistered = false;
  if (registerDefaults) {
    registerDefaultGuardrails();
  }
}

registerDefaultGuardrails();
