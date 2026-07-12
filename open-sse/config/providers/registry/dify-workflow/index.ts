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

import type { RegistryEntry } from "../../shared.ts";

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
 */
export const dify_workflowProvider: RegistryEntry = {
  id: "dify-workflow",
  alias: "dify-workflow",
  format: "openai",
  executor: "default",
  baseUrl: process.env.DIFY_API_URL || "http://localhost/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: [
    { id: "dify-chat-app", name: "Dify Chat App", contextLength: 128000 },
    { id: "dify-workflow-app", name: "Dify Workflow App", contextLength: 128000 },
    { id: "dify-agent-app", name: "Dify Agent App", contextLength: 128000 },
  ],
};
