/**
 * A2A Skill: Dify Workflow Delegation
 *
 * Delegates a task to a Dify Workflow/Chat/Agent app via AIRoute's
 * dify-workflow provider. Supports three Dify execution modes:
 *   - Chat App (conversational Q&A)
 *   - Workflow App (deterministic pipeline)
 *   - Agent App (autonomous reasoning with tool-calling)
 *
 * Requires:
 *   - AIRoute_API_KEY or an active session
 *   - DIFY_API_URL env var (Dify instance base URL)
 *   - Dify App API key configured for "dify-workflow" provider
 */

import type { A2ATask, TaskArtifact } from "../taskManager";
import { resolveAIRouteBaseUrl } from "@/shared/utils/resolveAIRouteBaseUrl";

const AIRoute_BASE_URL = resolveAIRouteBaseUrl();
const AIRoute_API_KEY = process.env.AIRoute_API_KEY || "";

async function difyFetch(path: string, options: RequestInit = {}): Promise<any> {
  const url = `${AIRoute_BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(AIRoute_API_KEY ? { Authorization: `Bearer ${AIRoute_API_KEY}` } : {}),
  };
  const res = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`Dify delegation API [${res.status}]: ${await res.text().catch(() => "error")}`);
  return res.json();
}

export interface DifyDelegationResult {
  artifacts: TaskArtifact[];
  metadata: {
    app_mode: "chat" | "workflow" | "agent";
    conversation_id?: string;
    workflow_run_id?: string;
    status: "success" | "partial" | "failed";
    execution_time_ms: number;
    total_tokens?: number;
  };
}

export async function executeDifyDelegation(task: A2ATask): Promise<DifyDelegationResult> {
  const messages = task.input.messages;
  const appMode = (task.input.metadata?.dify_app_mode as string) || "chat";

  // Determine which model ID to use based on Dify app mode
  const modelMap: Record<string, string> = {
    chat: "dify-chat-app",
    workflow: "dify-workflow-app",
    agent: "dify-agent-app",
  };
  const model = modelMap[appMode] || "dify-chat-app";

  const start = Date.now();

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
  };

  // Pass through Dify-specific metadata if available
  if (task.input.metadata?.dify_user) {
    body["user"] = task.input.metadata.dify_user;
  }
  if (task.input.metadata?.dify_conversation_id) {
    body["conversation_id"] = task.input.metadata.dify_conversation_id;
  }
  if (task.input.metadata?.dify_inputs && typeof task.input.metadata.dify_inputs === "object") {
    body["inputs"] = task.input.metadata.dify_inputs;
  }

  const raw = await difyFetch("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const executionTimeMs = Date.now() - start;
  const content = raw?.choices?.[0]?.message?.content || "";
  const status = content ? "success" : "partial";

  return {
    artifacts: [{ type: "text", content }],
    metadata: {
      app_mode: appMode as "chat" | "workflow" | "agent",
      conversation_id: raw?.conversation_id || undefined,
      workflow_run_id: raw?.workflow_run_id || undefined,
      status,
      execution_time_ms: executionTimeMs,
      total_tokens: raw?.usage?.total_tokens || undefined,
    },
  };
}
