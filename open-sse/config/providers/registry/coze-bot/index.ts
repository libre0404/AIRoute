/**
 * Coze Bot Provider Registry Entry
 *
 * Registers "coze-bot" as a provider in AIRoute's registry.
 * This allows AIRoute to forward requests to ByteDance's Coze Agent platform,
 * enabling agentic task execution (RAG, tool-calling, multi-turn workflows).
 *
 * The Coze bot executes the request using its configured knowledge base,
 * plugins, and workflow — AIRoute acts as the routing gateway.
 *
 * Requires:
 *   - COZE_BOT_ID env var (the bot to call)
 *   - API key with Coze Personal Access Token set
 *
 * @module providers/registry/coze-bot
 */

import type { RegistryEntry } from "../../shared.ts";

/**
 * Coze Bot Provider Registry Entry
 *
 * Registers "coze-bot" as a provider in AIRoute's registry.
 * This allows AIRoute to forward requests to ByteDance's Coze Agent platform,
 * enabling agentic task execution (RAG, tool-calling, multi-turn workflows).
 *
 * The Coze bot executes the request using its configured knowledge base,
 * plugins, and workflow — AIRoute acts as the routing gateway.
 *
 * Requires:
 *   - COZE_BOT_ID env var (the bot to call)
 *   - API key with Coze Personal Access Token set
 */
export const coze_botProvider: RegistryEntry = {
  id: "coze-bot",
  alias: "coze-bot",
  format: "openai",
  executor: "default",
  baseUrl:
    process.env.AIRROUTE_REGION === "cn"
      ? "https://api.coze.cn/v1/chat/completions"
      : (process.env.COZE_API_URL || "https://api.coze.com/v1/chat/completions"),
  authType: "apikey",
  authHeader: "bearer",
  models: [
    { id: "coze-bot-agent", name: "Coze Bot Agent", contextLength: 128000 },
    { id: "coze-bot-workflow", name: "Coze Workflow", contextLength: 128000 },
  ],
};
