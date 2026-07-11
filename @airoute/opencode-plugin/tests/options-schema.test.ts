/**
 * T-08 options-schema tests.
 *
 * Covers `parseAIRoutePluginOptions(opts)` — the strict Zod gate that
 * validates the second-arg `PluginOptions` bag from opencode.json before
 * any hook is wired. Anti-pattern checklist mirrored here:
 *
 *  - `null` / `undefined` must collapse to `{}` (defaults apply downstream).
 *  - Unknown keys must THROW (`.strict()` catches opencode.json typos).
 *  - Validation runs at parse time, not import time (module loads cleanly).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseAIRoutePluginOptions } from "../src/index.js";

test("parseAIRoutePluginOptions: undefined → {}", () => {
  assert.deepEqual(parseAIRoutePluginOptions(undefined), {});
});

test("parseAIRoutePluginOptions: null → {}", () => {
  assert.deepEqual(parseAIRoutePluginOptions(null), {});
});

test("parseAIRoutePluginOptions: empty object → {}", () => {
  assert.deepEqual(parseAIRoutePluginOptions({}), {});
});

test("parseAIRoutePluginOptions: valid providerId → returns it", () => {
  const r = parseAIRoutePluginOptions({ providerId: "AIRoute-preprod" });
  assert.equal(r.providerId, "AIRoute-preprod");
});

test("parseAIRoutePluginOptions: invalid providerId (special chars) → throws", () => {
  assert.throws(
    () => parseAIRoutePluginOptions({ providerId: "AIRoute prod!" }),
    /providerId.*slug/i
  );
});

test("parseAIRoutePluginOptions: empty providerId → throws", () => {
  assert.throws(() => parseAIRoutePluginOptions({ providerId: "" }), /providerId/i);
});

test("parseAIRoutePluginOptions: valid modelCacheTtl → returns it", () => {
  const r = parseAIRoutePluginOptions({ modelCacheTtl: 60_000 });
  assert.equal(r.modelCacheTtl, 60_000);
});

test("parseAIRoutePluginOptions: negative modelCacheTtl → throws", () => {
  assert.throws(() => parseAIRoutePluginOptions({ modelCacheTtl: -1 }), /modelCacheTtl/i);
});

test("parseAIRoutePluginOptions: zero modelCacheTtl → throws (positive required)", () => {
  assert.throws(() => parseAIRoutePluginOptions({ modelCacheTtl: 0 }), /modelCacheTtl/i);
});

test("parseAIRoutePluginOptions: invalid baseURL (not a URL) → throws", () => {
  assert.throws(() => parseAIRoutePluginOptions({ baseURL: "not-a-url" }), /baseURL/i);
});

test("parseAIRoutePluginOptions: unknown key → throws (strict mode catches typos)", () => {
  assert.throws(
    () =>
      parseAIRoutePluginOptions({
        providerId: "AIRoute",
        provider_id: "typo-here",
      }),
    /provider_id|unrecognized/i
  );
});

test("parseAIRoutePluginOptions: all four fields populated correctly → returns them", () => {
  const opts = {
    providerId: "AIRoute-prod",
    displayName: "AIRoute Production",
    modelCacheTtl: 120_000,
    baseURL: "https://or.example.com/v1",
  };
  const r = parseAIRoutePluginOptions(opts);
  assert.deepEqual(r, opts);
});

test("parseAIRoutePluginOptions: error message lists every issue path", () => {
  // Two bad fields at once → error string should mention BOTH.
  try {
    parseAIRoutePluginOptions({
      providerId: "",
      baseURL: "garbage",
    });
    assert.fail("expected throw");
  } catch (err) {
    const msg = (err as Error).message;
    assert.match(msg, /providerId/);
    assert.match(msg, /baseURL/);
  }
});

test("parseAIRoutePluginOptions: module import alone does NOT throw", async () => {
  // Re-importing the entry must not trigger validation; validation only fires
  // on explicit parseAIRoutePluginOptions / AIRoutePlugin invocation.
  const mod = await import("../src/index.js");
  assert.equal(typeof mod.parseAIRoutePluginOptions, "function");
});
