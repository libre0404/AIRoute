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

import type { RegistryEntry } from "../shared.ts";

const entry: RegistryEntry = {
  id: "coze-bot",
  alias: ["coze", "扣子"],
  format: "openai",
  executor: "default",
  baseUrl: () => {
    const region = process.env.AIRROUTE_REGION;
    return region === "cn"
      ? "https://api.coze.cn"
      : (process.env.COZE_API_URL || "https://api.coze.com");
  },
  authType: "bearer",
  authHeader: "Authorization",
  models: [
    { id: "coze-bot-agent", name: "Coze Bot Agent", context: 128000 },
    { id: "coze-bot-workflow", name: "Coze Workflow", context: 128000 },
  ],
};

export default entry;
