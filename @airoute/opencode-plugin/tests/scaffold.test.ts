import test from "node:test";
import assert from "node:assert/strict";
import {
  AIRoutePlugin,
  AIRoute_PROVIDER_KEY,
  DEFAULT_MODEL_CACHE_TTL_MS,
  resolveAIRoutePluginOptions,
} from "../src/index.js";

test("scaffold: exports public surface", () => {
  assert.equal(
    typeof AIRoutePlugin,
    "function",
    "AIRoutePlugin must be a function (Plugin factory)"
  );
  assert.equal(AIRoute_PROVIDER_KEY, "AIRoute");
  assert.equal(DEFAULT_MODEL_CACHE_TTL_MS, 300_000);
});

test("scaffold: default export is v1 plugin shape { id, server: AIRoutePlugin }", async () => {
  const mod = await import("../src/index.js");
  assert.equal(typeof mod.default, "object");
  assert.equal(mod.default.id, "@AIRoute/opencode-plugin");
  assert.equal(mod.default.server, mod.AIRoutePlugin);
});

test("resolveAIRoutePluginOptions: defaults", () => {
  const r = resolveAIRoutePluginOptions();
  assert.equal(r.providerId, "opencode-AIRoute");
  assert.equal(r.displayName, "AIRoute");
  assert.equal(r.modelCacheTtl, 300_000);
  assert.equal(r.baseURL, undefined);
});

test("resolveAIRoutePluginOptions: custom providerId derives displayName", () => {
  const r = resolveAIRoutePluginOptions({ providerId: "AIRoute-preprod" });
  assert.equal(r.providerId, "opencode-AIRoute-preprod");
  assert.equal(r.displayName, "AIRoute (opencode-AIRoute-preprod)");
});

test("resolveAIRoutePluginOptions: explicit displayName wins", () => {
  const r = resolveAIRoutePluginOptions({
    providerId: "AIRoute-x",
    displayName: "Custom Label",
  });
  assert.equal(r.displayName, "Custom Label");
});

test("resolveAIRoutePluginOptions: invalid TTL falls back to default", () => {
  assert.equal(resolveAIRoutePluginOptions({ modelCacheTtl: 0 }).modelCacheTtl, 300_000);
  assert.equal(resolveAIRoutePluginOptions({ modelCacheTtl: -1 }).modelCacheTtl, 300_000);
});

test("resolveAIRoutePluginOptions: positive TTL respected", () => {
  assert.equal(resolveAIRoutePluginOptions({ modelCacheTtl: 60_000 }).modelCacheTtl, 60_000);
});

test("AIRoutePlugin: returns an empty hooks object (scaffold)", async () => {
  const fakeCtx = {} as Parameters<typeof AIRoutePlugin>[0];
  const hooks = await AIRoutePlugin(fakeCtx);
  assert.equal(typeof hooks, "object");
  assert.notEqual(hooks, null);
});

test("scaffold: built ESM default export resolves with the v1 plugin shape", async () => {
  // The plugin is ESM-only now — the CJS bundle was dropped to fix the OpenCode
  // loader (#3883), so there is no more ../dist/index.cjs. Validate that the built
  // distributable's default export still carries the OpenCode v1 { id, server } shape.
  const mod = await import("../dist/index.js");
  assert.strictEqual(typeof mod.default, "object");
  assert.strictEqual(mod.default.id, "@AIRoute/opencode-plugin");
  assert.strictEqual(typeof mod.default.server, "function");
});
