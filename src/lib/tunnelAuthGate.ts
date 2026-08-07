/**
 * Tunnel Auth Gate — prevents public exposure of unauthenticated instances.
 *
 * Starting a tunnel (cloudflared / ngrok / Tailscale Funnel) publishes the
 * local AIRoute endpoint to the internet. When `REQUIRE_API_KEY` is disabled
 * the instance becomes an open proxy: anyone who discovers the public URL can
 * spend provider quota and abuse the connected upstream accounts.
 *
 * The gate blocks tunnel startup unless API-key auth is enforced, or the
 * operator explicitly opts out with `AIRoute_TUNNEL_ALLOW_NO_AUTH=true`
 * (intended for throw-away demos only — a loud warning is still logged).
 *
 * @module lib/tunnelAuthGate
 */

import { isRequireApiKeyEnabled } from "@/shared/utils/featureFlags";

/** Stable machine-readable code so UI/log consumers can match on it. */
export const TUNNEL_AUTH_GATE_ERROR_CODE = "TUNNEL_AUTH_REQUIRED";

export class TunnelAuthGateError extends Error {
  readonly code = TUNNEL_AUTH_GATE_ERROR_CODE;
}

/**
 * Throw unless the instance enforces API-key auth (or the operator has
 * explicitly opted out via `AIRoute_TUNNEL_ALLOW_NO_AUTH=true`).
 *
 * Call at the top of every tunnel/funnel startup path. `isRequireApiKeyEnabled()`
 * resolves the effective flag (DB override > env > default) and fails closed
 * (returns true) when resolution errors, so the gate errs on the safe side.
 */
export function assertTunnelAuthEnabled(): void {
  if (process.env.AIRoute_TUNNEL_ALLOW_NO_AUTH === "true") {
    console.warn(
      "[SECURITY] AIRoute_TUNNEL_ALLOW_NO_AUTH=true — starting a public tunnel while " +
        "REQUIRE_API_KEY is disabled. The instance will be reachable as an OPEN PROXY; " +
        "anyone with the tunnel URL can spend your provider quota."
    );
    return;
  }

  if (isRequireApiKeyEnabled()) return;

  throw new TunnelAuthGateError(
    "Tunnel blocked: REQUIRE_API_KEY is disabled, so exposing AIRoute publicly would " +
      "create an open proxy. Enable API-key auth (set REQUIRE_API_KEY=true or enable it " +
      "in Settings → Feature Flags), then start the tunnel again. For intentional demos " +
      "you may bypass this gate with AIRoute_TUNNEL_ALLOW_NO_AUTH=true (NOT recommended)."
  );
}
