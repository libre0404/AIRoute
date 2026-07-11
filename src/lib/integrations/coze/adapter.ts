/**
 * Coze (扣子) Integration Adapter — 字节跳动 Coze Agent 平台适配层
 *
 * Coze is ByteDance's agent platform (https://www.coze.cn).
 * This adapter provides:
 *
 * 1. **Coze as a Provider**: AIRoute can forward requests to Coze Bot API,
 *    enabling agentic task execution (RAG, tool-calling, multi-turn workflows)
 *    via Coze bots. The adapter translates OpenAI chat format → Coze chat API.
 *
 * 2. **Coze as a Consumer**: Coze workflows can call AIRoute's OpenAI-compatible
 *    `/v1/chat/completions` endpoint directly — no adapter needed on that side.
 *    Just configure AIRoute as a "custom model" in Coze's model settings.
 *
 * API Reference: https://www.coze.cn/docs/developer_guides/chat_v3
 *
 * Configuration:
 *   COZE_API_URL=https://api.coze.cn          (China instance)
 *   COZE_API_URL=https://api.coze.com         (International instance)
 *   COZE_BOT_ID=xxx                            (Required for bot chat)
 *   COZE_USER_ID=airoute-default               (User ID for Coze chat)
 *
 * @module integrations/coze
 */

// ── Types ──

export interface CozeChatRequest {
  bot_id: string;
  user_id: string;
  /** "1" for streaming, "0" for non-streaming */
  stream?: string;
  auto_save_history?: boolean;
  additional_messages?: CozeMessage[];
  custom_variables?: Record<string, string>;
}

export interface CozeMessage {
  role: "user" | "assistant";
  content: string;
  content_type: "text";
}

export interface CozeChatEvent {
  event: string;
  message?: {
    id: string;
    role: string;
    content: string;
    type: string;
    created_at: number;
  };
  conversation_id?: string;
  id?: string;
  is_answer?: boolean;
  usage?: {
    input_count: number;
    output_count: number;
  };
}

export interface CozeAdapterConfig {
  apiUrl: string;
  botId: string;
  userId: string;
  apiKey: string;
}

// ── Default Config ──

function resolveCozeApiUrl(): string {
  const env = process.env.COZE_API_URL;
  if (env) return env;
  // Auto-select based on AIRROUTE_REGION
  return process.env.AIRROUTE_REGION === "cn"
    ? "https://api.coze.cn"
    : "https://api.coze.com";
}

export function getDefaultCozeConfig(apiKey: string): CozeAdapterConfig {
  return {
    apiUrl: resolveCozeApiUrl(),
    botId: process.env.COZE_BOT_ID || "",
    userId: process.env.COZE_USER_ID || "airoute-default",
    apiKey,
  };
}

// ── Request Translation ──

/**
 * Convert OpenAI-compatible messages to Coze chat format.
 * Maps system→first user message prefix, assistant→assistant, user→user.
 */
export function openAIMessagesToCoze(
  messages: Array<{ role: string; content: string }>
): CozeMessage[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      if (m.role === "system") {
        // Coze doesn't have a system role; prepend to the first user message
        return { role: "user" as const, content: m.content, content_type: "text" as const };
      }
      return {
        role: m.role as "user" | "assistant",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        content_type: "text" as const,
      };
    });
}

// ── Response Translation ──

/**
 * Convert Coze streaming events to SSE chunks in OpenAI format.
 */
export function cozeEventToOpenAIChunk(
  event: CozeChatEvent,
  model: string
): string | null {
  if (event.event === "conversation.chat.created") {
    return null; // Meta event, skip
  }

  if (event.event === "conversation.message.delta" && event.message) {
    const delta: Record<string, unknown> = {
      id: event.message.id || `chatcmpl-coze-${Date.now()}`,
      object: "chat.completion.chunk",
      created: event.message.created_at || Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: { content: event.message.content },
          finish_reason: null,
        },
      ],
    };
    return `data: ${JSON.stringify(delta)}\n\n`;
  }

  if (event.event === "conversation.message.completed" && event.message?.is_answer) {
    const chunk: Record<string, unknown> = {
      id: event.message.id || `chatcmpl-coze-${Date.now()}`,
      object: "chat.completion.chunk",
      created: event.message.created_at || Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    };

    const usage = event.usage
      ? {
          prompt_tokens: event.usage.input_count,
          completion_tokens: event.usage.output_count,
          total_tokens: event.usage.input_count + event.usage.output_count,
        }
      : undefined;

    if (usage) chunk.usage = usage;

    return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
  }

  if (event.event === "done") {
    return "data: [DONE]\n\n";
  }

  return null; // Skip other events
}

/**
 * Convert a Coze non-streaming response to OpenAI format.
 */
export function cozeResponseToOpenAI(
  messages: Array<{ content: string; id?: string }>,
  model: string,
  usage?: { input_count: number; output_count: number }
): Record<string, unknown> {
  const answerMessage = messages.find((m) => m.content) || { content: "", id: "none" };
  return {
    id: answerMessage.id || `chatcmpl-coze-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: answerMessage.content },
        finish_reason: "stop",
      },
    ],
    usage: usage
      ? {
          prompt_tokens: usage.input_count,
          completion_tokens: usage.output_count,
          total_tokens: usage.input_count + usage.output_count,
        }
      : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ── Health Check ──

/**
 * Verify Coze API connectivity by listing bots (lightweight read-only call).
 */
export async function checkCozeHealth(config: CozeAdapterConfig): Promise<{
  healthy: boolean;
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    const resp = await fetch(`${config.apiUrl}/v1/bots?space_id=default`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });
    return {
      healthy: resp.ok || resp.status === 403, // 403 = auth works, no space access
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
