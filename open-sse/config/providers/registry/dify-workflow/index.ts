/**
 * Dify Workflow Provider Registry Entry
 *
 * Registers "dify-workflow" as a provider in AIRoute's registry.
 * This allows AIRoute to forward requests to a Dify instance,
 * enabling agentic task execution via Dify workflows and chat apps.
 *
 * Requires:
 *   - DIFY_API_URL env var (Dify instance base URL)
 *   - API key with Dify App API key set
 *
 * @module providers/registry/dify-workflow
 */

import type { RegistryEntry } from "../shared.ts";

const entry: RegistryEntry = {
  id: "dify-workflow",
  alias: ["dify", "dify-chat"],
  format: "openai",
  executor: "default",
  baseUrl: () => process.env.DIFY_API_URL || "http://localhost/v1",
  authType: "bearer",
  authHeader: "Authorization",
  models: [
    { id: "dify-chat-app", name: "Dify Chat App", context: 128000 },
    { id: "dify-workflow-app", name: "Dify Workflow App", context: 128000 },
    { id: "dify-agent-app", name: "Dify Agent App", context: 128000 },
  ],
};

export default entry;
