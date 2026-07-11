/**
 * A2A Skill: Coze Agent Delegation
 *
 * Delegates a task to a Coze (扣子) Bot via AIRoute's coze-bot provider.
 * The Coze bot executes using its configured knowledge base, plugins,
 * and workflow — useful for RAG, tool-calling, and multi-turn workflows
 * hosted on ByteDance's Coze Agent platform.
 *
 * Requires:
 *   - AIRoute_API_KEY or an active session
 *   - COZE_BOT_ID env var (target bot)
 *   - Coze PAT configured as API key for "coze-bot" provider
 */

import type { A2ATask, TaskArtifact } from "../taskManager";
import { resolveAIRouteBaseUrl } from "@/shared/utils/resolveAIRouteBaseUrl";

const AIRoute_BASE_URL = resolveAIRouteBaseUrl();
const AIRoute_API_KEY = process.env.AIRoute_API_KEY || "";

async function cozeFetch(path: string, options: RequestInit = {}): Promise<any> {
  const url = `${AIRoute_BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(AIRoute_API_KEY ? { Authorization: `Bearer ${AIRoute_API_KEY}` } : {}),
  };
  const res = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Coze delegation API [${res.status}]: ${await res.text().catch(() => "error")}`);
  return res.json();
}

export interface CozeDelegationResult {
  artifacts: TaskArtifact[];
  metadata: {
    bot_id: string;
    conversation_id?: string;
    status: "success" | "partial" | "failed";
    execution_time_ms: number;
  };
}

export async function executeCozeDelegation(task: A2ATask): Promise<CozeDelegationResult> {
  const messages = task.input.messages;
  const botId = process.env.COZE_BOT_ID || (task.input.metadata?.coze_bot_id as string) || "";

  if (!botId) {
    throw new Error("Coze delegation requires COZE_BOT_ID env var or metadata.coze_bot_id");
  }

  const start = Date.now();

  // Route through AIRoute's coze-bot provider using /v1/chat/completions
  const body: Record<string, unknown> = {
    model: "coze-bot-agent",
    messages,
    stream: false,
  };

  const raw = await cozeFetch("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const executionTimeMs = Date.now() - start;
  const content = raw?.choices?.[0]?.message?.content || "";
  const status = content ? "success" : "partial";

  return {
    artifacts: [{ type: "text", content }],
    metadata: {
      bot_id: botId,
      conversation_id: raw?.id || undefined,
      status,
      execution_time_ms: executionTimeMs,
    },
  };
}
