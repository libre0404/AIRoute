import { runWithProxyContext, getOriginalFetch } from "@AIRoute/open-sse/utils/proxyFetch.ts";
import { FetchTimeoutError, fetchWithTimeout } from "@/shared/utils/fetchTimeout";
import {
  OutboundUrlGuardError,
  type OutboundUrlGuardMode,
  parseAndValidateNonMetadataUrl,
  parseAndValidatePublicUrl,
  parseOutboundUrl,
} from "@/shared/network/outboundUrlGuard";

const DEFAULT_IDEMPOTENT_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"];

// [N-04 FIX] Maximum number of manual redirect hops when allowRedirect is true.
// Each hop re-validates the redirect target against the URL guard to prevent
// SSRF via open redirect chains (e.g. public URL → 302 → internal metadata endpoint).
const MAX_REDIRECT_HOPS = 5;

export type SafeOutboundFetchGuard = OutboundUrlGuardMode;
export type SafeOutboundFetchErrorCode =
  | "INVALID_URL"
  | "URL_GUARD_BLOCKED"
  | "TIMEOUT"
  | "REDIRECT_BLOCKED"
  | "NETWORK_ERROR";

export interface SafeOutboundFetchRetryOptions {
  attempts?: number;
  backoffMs?: number | number[];
  methods?: string[];
  statusCodes?: number[];
}

export interface SafeOutboundFetchOptions extends RequestInit {
  timeoutMs?: number;
  allowRedirect?: boolean;
  retry?: SafeOutboundFetchRetryOptions | false;
  guard?: SafeOutboundFetchGuard;
  proxyConfig?: unknown;
  /** Bypass the global proxy/TLS patched fetch and use the native Node.js
   *  fetch directly. Use when a provider endpoint has compatibility issues
   *  with the undici dispatcher layer. */
  bypassProxyPatch?: boolean;
}

type SafeOutboundFetchPresetMap = {
  validationRead: SafeOutboundFetchOptions;
  validationWrite: SafeOutboundFetchOptions;
  modelsProbe: SafeOutboundFetchOptions;
  modelsDiscovery: SafeOutboundFetchOptions;
  modelsPagination: SafeOutboundFetchOptions;
};

export const SAFE_OUTBOUND_FETCH_PRESETS: SafeOutboundFetchPresetMap = {
  validationRead: {
    timeoutMs: 5000,
    allowRedirect: false,
    retry: {
      attempts: 2,
      backoffMs: [150],
      methods: ["GET", "HEAD"],
    },
  },
  validationWrite: {
    timeoutMs: 15000,
    allowRedirect: false,
    retry: false,
  },
  modelsProbe: {
    timeoutMs: 5000,
    allowRedirect: false,
    retry: {
      attempts: 2,
      backoffMs: [150],
      methods: ["GET", "HEAD"],
    },
  },
  modelsDiscovery: {
    timeoutMs: 10000,
    allowRedirect: false,
    retry: {
      attempts: 2,
      backoffMs: [200],
      methods: ["GET", "HEAD"],
    },
  },
  modelsPagination: {
    timeoutMs: 15000,
    allowRedirect: false,
    retry: {
      attempts: 2,
      backoffMs: [250],
      methods: ["GET", "HEAD"],
    },
  },
};

type SafeOutboundFetchErrorInit = {
  code: SafeOutboundFetchErrorCode;
  url: string;
  method: string;
  attempts: number;
  isRetryable: boolean;
  timeoutMs?: number;
  status?: number;
  location?: string | null;
  cause?: unknown;
};

export class SafeOutboundFetchError extends Error {
  code: SafeOutboundFetchErrorCode;
  url: string;
  method: string;
  attempts: number;
  isRetryable: boolean;
  timeoutMs?: number;
  status?: number;
  location?: string | null;

  constructor(message: string, init: SafeOutboundFetchErrorInit) {
    super(message);
    this.name = "SafeOutboundFetchError";
    this.code = init.code;
    this.url = init.url;
    this.method = init.method;
    this.attempts = init.attempts;
    this.isRetryable = init.isRetryable;
    this.timeoutMs = init.timeoutMs;
    this.status = init.status;
    this.location = init.location ?? null;
    if (init.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = init.cause;
    }
  }
}

function normalizeMethod(method?: string) {
  return (method || "GET").toUpperCase();
}

function normalizeUrl(input: string | URL) {
  try {
    return parseOutboundUrl(input);
  } catch (error) {
    if (error instanceof OutboundUrlGuardError) {
      throw new SafeOutboundFetchError(error.message, {
        code: error.code === "OUTBOUND_URL_INVALID" ? "INVALID_URL" : "URL_GUARD_BLOCKED",
        url: error.url,
        method: "GET",
        attempts: 1,
        isRetryable: false,
        cause: error,
      });
    }
    throw new SafeOutboundFetchError(`Invalid outbound URL: ${String(input)}`, {
      code: "INVALID_URL",
      url: String(input),
      method: "GET",
      attempts: 1,
      isRetryable: false,
      cause: error,
    });
  }
}

function applyUrlGuard(targetUrl: URL, guard: SafeOutboundFetchGuard, method: string) {
  if (guard === "none") return;

  try {
    // "public-only" rejects every private host; "block-metadata" (#5066) allows private/LAN
    // hosts but still rejects cloud-metadata / link-local endpoints.
    if (guard === "block-metadata") {
      parseAndValidateNonMetadataUrl(targetUrl);
    } else {
      parseAndValidatePublicUrl(targetUrl);
    }
  } catch (error) {
    if (error instanceof OutboundUrlGuardError) {
      throw new SafeOutboundFetchError(error.message, {
        code: error.code === "OUTBOUND_URL_INVALID" ? "INVALID_URL" : "URL_GUARD_BLOCKED",
        url: error.url,
        method,
        attempts: 1,
        isRetryable: false,
        cause: error,
      });
    }
    throw error;
  }
}

function getRetryConfig(retry: SafeOutboundFetchRetryOptions | false | undefined, method: string) {
  if (retry === false) {
    return {
      attempts: 1,
      shouldRetryMethod: false,
      statusCodes: new Set<number>(),
      backoffMs: [] as number[],
    };
  }

  const methods = new Set(
    (retry?.methods || DEFAULT_IDEMPOTENT_METHODS).map((value) => value.toUpperCase())
  );
  const attempts = Math.max(1, retry?.attempts || 1);
  const backoffMs = Array.isArray(retry?.backoffMs)
    ? retry?.backoffMs
    : typeof retry?.backoffMs === "number"
      ? [retry.backoffMs]
      : [];
  const statusCodes = new Set(retry?.statusCodes || []);

  return {
    attempts,
    shouldRetryMethod: methods.has(method),
    statusCodes,
    backoffMs,
  };
}

function getBackoffDelay(backoffMs: number[], attemptNumber: number) {
  if (backoffMs.length === 0) return 0;
  return backoffMs[Math.min(attemptNumber - 1, backoffMs.length - 1)] || 0;
}

function sleep(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cancelResponseBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore body cancellation errors when preparing a retry.
  }
}

function normalizeFetchFailure(
  error: unknown,
  targetUrl: string,
  method: string,
  attempts: number
): SafeOutboundFetchError {
  if (error instanceof SafeOutboundFetchError) {
    error.attempts = attempts;
    return error;
  }

  if (error instanceof FetchTimeoutError) {
    return new SafeOutboundFetchError(error.message, {
      code: "TIMEOUT",
      url: targetUrl,
      method,
      attempts,
      timeoutMs: error.timeoutMs,
      isRetryable: true,
      cause: error,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" ? (error as { code?: string }).code : undefined;

  return new SafeOutboundFetchError(message || `Outbound request failed for ${targetUrl}`, {
    code: "NETWORK_ERROR",
    url: targetUrl,
    method,
    attempts,
    isRetryable: code !== "PROXY_UNREACHABLE",
    cause: error,
  });
}

export async function safeOutboundFetch(url: string | URL, options: SafeOutboundFetchOptions = {}) {
  const targetUrl = normalizeUrl(url);
  const method = normalizeMethod(options.method);
  const {
    timeoutMs,
    allowRedirect = false,
    retry,
    guard = "none",
    proxyConfig,
    bypassProxyPatch = false,
    signal,
    ...fetchOptions
  } = options;

  applyUrlGuard(targetUrl, guard, method);

  const retryConfig = getRetryConfig(retry, method);
  // [N-04 FIX] Always use manual redirect — when allowRedirect is true we
  // follow redirects manually with per-hop URL guard validation to prevent
  // SSRF via redirect chains. When false, 3xx responses throw REDIRECT_BLOCKED.
  const redirect: RequestRedirect = "manual";

  for (let attempt = 1; attempt <= retryConfig.attempts; attempt++) {
    try {
      const executeFetch = () =>
        fetchWithTimeout(targetUrl.toString(), {
          ...fetchOptions,
          method,
          redirect,
          signal,
          timeoutMs,
          // When bypassing the proxy patch, use the original native fetch directly.
          fetchFn: bypassProxyPatch ? getOriginalFetch() : undefined,
        });

      let response = bypassProxyPatch
        ? await executeFetch()
        : proxyConfig
          ? await runWithProxyContext(proxyConfig, executeFetch)
          : await executeFetch();

      // [N-04 FIX] Manual redirect following with per-hop SSRF validation.
      // When allowRedirect is true, follow each 3xx hop individually, re-applying
      // the URL guard to each Location target. This prevents SSRF attacks where
      // an attacker sets up a public URL that 302-redirects to internal endpoints
      // (e.g. cloud metadata at 169.254.169.254).
      if (allowRedirect) {
        let hopCount = 0;
        let currentUrl = targetUrl.toString();
        while (response.status >= 300 && response.status < 400 && hopCount < MAX_REDIRECT_HOPS) {
          const location = response.headers.get("location");
          await cancelResponseBody(response);

          if (!location) {
            throw new SafeOutboundFetchError(
              `Redirect without Location header for ${method} ${currentUrl} (${response.status})`,
              {
                code: "REDIRECT_BLOCKED",
                url: currentUrl,
                method,
                attempts: attempt,
                status: response.status,
                location: null,
                isRetryable: false,
              }
            );
          }

          // Resolve the redirect URL against the current URL
          let redirectUrl: URL;
          try {
            redirectUrl = new URL(location, currentUrl);
          } catch {
            throw new SafeOutboundFetchError(
              `Invalid redirect Location: ${location}`,
              {
                code: "REDIRECT_BLOCKED",
                url: currentUrl,
                method,
                attempts: attempt,
                status: response.status,
                location,
                isRetryable: false,
              }
            );
          }

          // [N-04 FIX] Re-apply URL guard on each redirect hop.
          // This is the critical mitigation — without it, an attacker can
          // use an open redirect on a public host to bypass SSRF protection
          // and reach internal services.
          applyUrlGuard(redirectUrl, guard, method);

          hopCount++;
          currentUrl = redirectUrl.toString();

          // Re-execute fetch to the new URL within the same attempt
          const hopFetch = () =>
            fetchWithTimeout(currentUrl, {
              ...fetchOptions,
              method: [301, 302, 303].includes(response.status) ? "GET" : method,
              redirect: "manual",
              signal,
              timeoutMs,
              fetchFn: bypassProxyPatch ? getOriginalFetch() : undefined,
              // 303 redirects drop the body; 301/302 also convert to GET per HTTP spec
              body: [301, 302, 303].includes(response.status) ? undefined : fetchOptions.body,
            });

          response = bypassProxyPatch
            ? await hopFetch()
            : proxyConfig
              ? await runWithProxyContext(proxyConfig, hopFetch)
              : await hopFetch();
        }

        // If we've exhausted redirect hops and still have a 3xx, block it
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await cancelResponseBody(response);
          throw new SafeOutboundFetchError(
            `Too many redirects (${MAX_REDIRECT_HOPS}) for ${method} ${targetUrl.toString()}`,
            {
              code: "REDIRECT_BLOCKED",
              url: currentUrl,
              method,
              attempts: attempt,
              status: response.status,
              location,
              isRetryable: false,
            }
          );
        }
      } else {
        // No redirect following — block any 3xx immediately
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await cancelResponseBody(response);
          throw new SafeOutboundFetchError(
            `Redirect blocked for ${method} ${targetUrl.toString()} (${response.status})`,
            {
              code: "REDIRECT_BLOCKED",
              url: targetUrl.toString(),
              method,
              attempts: attempt,
              status: response.status,
              location,
              isRetryable: false,
            }
          );
        }
      }

      if (
        retryConfig.shouldRetryMethod &&
        attempt < retryConfig.attempts &&
        retryConfig.statusCodes.has(response.status)
      ) {
        await cancelResponseBody(response);
        await sleep(getBackoffDelay(retryConfig.backoffMs, attempt));
        continue;
      }

      return response;
    } catch (error) {
      const normalizedError = normalizeFetchFailure(error, targetUrl.toString(), method, attempt);
      const shouldRetry =
        retryConfig.shouldRetryMethod &&
        attempt < retryConfig.attempts &&
        normalizedError.isRetryable;

      if (!shouldRetry) {
        throw normalizedError;
      }

      await sleep(getBackoffDelay(retryConfig.backoffMs, attempt));
    }
  }

  throw new SafeOutboundFetchError(`Outbound request failed for ${targetUrl.toString()}`, {
    code: "NETWORK_ERROR",
    url: targetUrl.toString(),
    method,
    attempts: retryConfig.attempts,
    isRetryable: false,
  });
}

export function getSafeOutboundFetchErrorStatus(error: unknown) {
  if (!(error instanceof SafeOutboundFetchError)) return null;

  if (error.code === "TIMEOUT") return 504;
  if (
    error.code === "INVALID_URL" ||
    error.code === "URL_GUARD_BLOCKED" ||
    error.code === "REDIRECT_BLOCKED"
  ) {
    return 503;
  }

  return null;
}
