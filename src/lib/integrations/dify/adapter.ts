/**
 * Dify Integration Adapter — Dify 开源 Agent 平台适配层
 *
 * Dify is an open-source LLM app development platform (https://dify.ai).
 * This adapter provides:
 *
 * 1. **Dify as a Provider**: AIRoute can forward requests to Dify's chat/workflow API,
 *    enabling agentic task execution via Dify workflows and agents.
 *
 * 2. **Dify as a Consumer**: Dify can call AIRoute's OpenAI-compatible
 *    `/v1/chat/completions` endpoint directly — configure AIRoute as a
 *    "custom model provider" in Dify's settings.
 *
 * API Reference: https://docs.dify.ai/guides/application-publishing/developing-with-apis
 *
 * Configuration:
 *   DIFY_API_URL=http://localhost/v1           (Dify instance base URL)
 *   DIFY_APP_TYPE=chat                         (chat | workflow | completion)
 *   DIFY_DEFAULT_USER=airoute-default          (End-user ID for Dify API)
 *
 * @module integrations/dify
 */

// ── Types ──

export interface DifyChatRequest {
  inputs: Record<string, string>;
  query: string;
  response_mode: "blocking" | "streaming";
  conversation_id?: string;
  user: string;
  files?: DifyFile[];
}

export interface DifyWorkflowRequest {
  inputs: Record<string, string>;
  response_mode: "blocking" | "streaming";
  user: string;
  files?: DifyFile[];
}

export interface DifyFile {
  type: "image" | "document" | "audio" | "video";
  transfer_method: "remote_url" | "local_file";
  url?: string;
  upload_file_id?: string;
}

export interface DifyStreamEvent {
  event: string;
  task_id?: string;
  id?: string;
  answer?: string;
  conversation_id?: string;
  message_id?: string;
  metadata?: {
    usage?: {
      prompt_tokens: number;
      prompt_unit_price: string;
      prompt_price_unit: string;
      prompt_price: string;
      completion_tokens: number;
      completion_unit_price: string;
      completion_price_unit: string;
      completion_price: string;
      total_tokens: number;
      total_price: string;
      currency: string;
    };
    retriever_resources?: Array<{
      position: number;
      dataset_id: string;
      dataset_name: string;
      document_id: string;
      document_name: string;
      data_source_type: string;
      segment_id: string;
      score: number;
      content: string;
    }>;
  };
}

export interface DifyAdapterConfig {
  apiUrl: string;
  appType: "chat" | "workflow" | "completion";
  defaultUser: string;
  apiKey: string;
}

// ── Default Config ──

export function getDefaultDifyConfig(apiKey: string): DifyAdapterConfig {
  return {
    apiUrl: process.env.DIFY_API_URL || "http://localhost/v1",
    appType: (process.env.DIFY_APP_TYPE as DifyAdapterConfig["appType"]) || "chat",
    defaultUser: process.env.DIFY_DEFAULT_USER || "airoute-default",
    apiKey,
  };
}

// ── Request Translation ──

/**
 * Convert OpenAI-compatible messages to Dify chat request.
 * Takes the last user message as query, and any prior messages as conversation context.
 */
export function openAIMessagesToDify(
  messages: Array<{ role: string; content: string }>,
  config: DifyAdapterConfig,
  conversationId?: string
): DifyChatRequest {
  // Dify chat API takes a single query + conversation_id for context
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const query = lastUserMessage?.content || "";

  return {
    inputs: {},
    query: typeof query === "string" ? query : JSON.stringify(query),
    response_mode: "streaming",
    conversation_id: conversationId,
    user: config.defaultUser,
  };
}

// ── Response Translation ──

/**
 * Convert Dify streaming events to SSE chunks in OpenAI format.
 */
export function difyEventToOpenAIChunk(
  event: DifyStreamEvent,
  model: string
): string | null {
  if (event.event === "message") {
    const chunk: Record<string, unknown> = {
      id: event.message_id || `chatcmpl-dify-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: { content: event.answer || "" },
          finish_reason: null,
        },
      ],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  if (event.event === "message_end") {
    const chunk: Record<string, unknown> = {
      id: event.message_id || `chatcmpl-dify-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    };

    const usage = event.metadata?.usage;
    if (usage) {
      chunk.usage = {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      };
    }

    return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
  }

  if (event.event === "workflow_finished") {
    return "data: [DONE]\n\n";
  }

  if (event.event === "error") {
    const errorChunk: Record<string, unknown> = {
      id: `chatcmpl-dify-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    };
    return `data: ${JSON.stringify(errorChunk)}\n\ndata: [DONE]\n\n`;
  }

  // Skip other events (ping, agent_message, agent_thought, etc.)
  return null;
}

/**
 * Convert a Dify non-streaming response to OpenAI format.
 */
export function difyResponseToOpenAI(
  answer: string,
  model: string,
  conversationId?: string,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): Record<string, unknown> {
  return {
    id: `chatcmpl-dify-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: answer },
        finish_reason: "stop",
      },
    ],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ── Health Check ──

/**
 * Verify Dify API connectivity by checking the parameters endpoint.
 */
export async function checkDifyHealth(config: DifyAdapterConfig): Promise<{
  healthy: boolean;
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    const endpoint = config.appType === "workflow"
      ? "/parameters"
      : "/parameters";
    const resp = await fetch(`${config.apiUrl}${endpoint}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });
    return {
      healthy: resp.ok || resp.status === 404, // 404 = app exists but no params
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message.message : String(err),
    };
  }
}

// ── Conversation ID Tracking ──

/**
 * Derive a stable Dify conversation_id from AIRoute session context.
 * This allows multi-turn conversations to maintain context in Dify.
 */
export function deriveDifyConversationId(
  sessionId: string | null | undefined,
  comboName: string | null | undefined
): string | undefined {
  if (!sessionId) return undefined;
  // Use a deterministic derivation so the same session always maps to
  // the same Dify conversation
  const raw = `dify-conv:${sessionId}:${comboName || "default"}`;
  // Simple hash (not crypto-grade, just for deterministic mapping)
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return `conv-${Math.abs(hash).toString(36)}`;
}
