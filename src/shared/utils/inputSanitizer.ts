/**
 * Input Sanitizer — FASE-01 Security Hardening
 *
 * Detects prompt injection patterns and redacts PII from LLM requests.
 * Configurable via environment variables or dashboard settings.
 *
 * @module inputSanitizer
 */

// ─── Prompt Injection Patterns ───────────────────────────────────────

/** @type {Array<{name: string, pattern: RegExp, severity: string}>} */
const INJECTION_PATTERNS = [
  {
    name: "system_override",
    pattern:
      /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|context)/i,
    severity: "high",
  },
  {
    name: "role_hijack",
    pattern:
      /\b(you\s+are\s+now|act\s+as\s+if|pretend\s+(to\s+be|you\s+are)|from\s+now\s+on\s+you\s+are)\b/i,
    severity: "medium",
  },
  {
    name: "system_prompt_leak",
    // #4041: require a system/initial/hidden/original qualifier before prompt|instructions.
    // The old pattern matched a bare "instructions" after reveal/show/display/etc, so it
    // tripped `high` on essentially all coding-agent traffic ("show the instructions",
    // "display your instructions"), making the always-on guard a hot-path false-positive.
    // Real leak attempts ("reveal your system prompt", "print the initial prompt") still
    // match, and qualified instruction leaks ("display your system instructions") now do too.
    pattern:
      /\b(reveals?|shows?|displays?|prints?|outputs?|repeats?)\s+((your|the)\s+)?(system|initial|hidden|original)\s+(prompt|instructions?)/i,
    severity: "high",
  },
  {
    name: "delimiter_injection",
    pattern: /(\[SYSTEM\]|\[INST\]|<<SYS>>|<\|im_start\|>|<\|system\|>|<\|user\|>)/i,
    severity: "high",
  },
  {
    name: "jailbreak_dan",
    pattern: /\b(DAN|do\s+anything\s+now|jailbreak|developer\s+mode|enable\s+developer)\b/i,
    severity: "medium",
  },
  {
    name: "encoding_evasion",
    pattern:
      /\b(base64\s+decode|rot13|hex\s+decode|unicode\s+escape)\b.*\b(instruction|prompt|command)\b/i,
    severity: "medium",
  },
  // ── Chinese injection patterns (A-01 FIX) ──
  // Attackers targeting Chinese-language LLM endpoints use translated equivalents
  // of the English injection patterns above. GB/T 35273-2020 / 个人信息保护法
  // also mandates PII controls for Chinese content.
  {
    name: "cn_system_override",
    pattern:
      /(忽略|无视|忘记|不要管|不用管)(所有|全部)?(之前的|先前的|上面的|前面的)(指令|提示|规则|上下文|设定)/,
    severity: "high",
  },
  {
    name: "cn_role_hijack",
    pattern:
      /(你现在是|从现在起你是|假装你是|请扮演|你是.+模式|开启.+模式|进入.+模式)/,
    severity: "high",
  },
  {
    name: "cn_system_prompt_leak",
    pattern:
      /(输出|显示|打印|展示|重复|泄露|透露)(你的|系统的)?(系统|初始|隐藏|原始|内部|核心)(提示|指令|设定|规则|prompt)/,
    severity: "high",
  },
  {
    name: "cn_jailbreak",
    pattern:
      /(越狱|解锁|开发者模式|管理员模式|超级用户|绕过|突破限制|不受限制)/,
    severity: "medium",
  },
  {
    name: "cn_instruction_injection",
    pattern:
      /(新指令|以下指令优先|覆盖之前的指令|这是你的新角色|请执行以下|安全限制已解除|不再需要遵守)/,
    severity: "high",
  },
];

/**
 * Maximum number of characters scanned for prompt-injection patterns.
 *
 * The guard joins every message/system string into one buffer and runs several
 * regexes over it on every chat request. With no cap that is O(body) CPU on the
 * hot path — at high concurrency with 300 KB bodies it is a self-inflicted
 * latency/GC source. Injection directives sit near the top of a prompt, so
 * scanning hundreds of KB of pasted code / RAG context buys only CPU. We bound
 * the scan to the first 32 KB (generous: real directives are far shorter, but
 * Chinese text is denser and injection payloads may be deeper in multi-turn
 * conversations) before the regex loop. The body-size caps that protect
 * ingestion live elsewhere; this constant only bounds the regex scan.
 * Refs #3932 / #4041 / A-01.
 */
export const MAX_INJECTION_SCAN_BYTES = 32 * 1024;

// ─── PII Patterns ────────────────────────────────────────────────────

/** @type {Array<{name: string, pattern: RegExp, replacement: string}>} */
const PII_PATTERNS = [
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    replacement: "[EMAIL_REDACTED]",
  },
  {
    name: "cpf",
    pattern: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g,
    replacement: "[CPF_REDACTED]",
  },
  {
    name: "cnpj",
    pattern: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g,
    replacement: "[CNPJ_REDACTED]",
  },
  {
    name: "credit_card",
    pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    replacement: "[CARD_REDACTED]",
  },
  {
    name: "phone_br",
    pattern: /\b\(?\d{2}\)?\s?\d{4,5}-?\d{4}\b/g,
    replacement: "[PHONE_REDACTED]",
  },
  {
    name: "ssn_us",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[SSN_REDACTED]",
  },
  // ── China PII patterns (GB/T 35273-2020 / 个人信息保护法) ──
  {
    name: "cn_id_card",
    // 18-digit Chinese resident ID card: 6-digit region + 8-digit DOB + 3-digit seq + 1 check (0-9/X)
    pattern: /(?<=^|[^A-Za-z0-9])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?=$|[^A-Za-z0-9])/g,
    replacement: "[CN_ID_REDACTED]",
  },
  {
    name: "cn_phone",
    // Chinese mobile: +86 (optional) + 11-digit starting with 1
    pattern: /(?<=^|[^A-Za-z0-9])(?:\+?86[-.\s]?)?1[3-9]\d{9}(?=$|[^A-Za-z0-9])/g,
    replacement: "[CN_PHONE_REDACTED]",
  },
  {
    name: "cn_bank_card",
    // Chinese bank card (UnionPay): 16-19 digits, starts with 62 (UnionPay) or other BIN ranges
    pattern: /(?<=^|[^A-Za-z0-9])62\d{14,17}(?=$|[^A-Za-z0-9])/g,
    replacement: "[CN_BANK_REDACTED]",
  },
];

// ─── Configuration ────────────────────────────────────────────────────

import { isFeatureFlagEnabled } from "@/shared/utils/featureFlags";

/**
 * Get sanitizer configuration from environment.
 * PII redaction defaults follow region-aware feature flags (auto → true when AIRROUTE_REGION=cn).
 * @returns {{ enabled: boolean, mode: string, piiRedaction: boolean }}
 */
function getConfig() {
  return {
    enabled: process.env.INPUT_SANITIZER_ENABLED !== "false",
    mode: process.env.INPUT_SANITIZER_MODE || "warn", // "warn" | "block" | "redact"
    piiRedaction: isFeatureFlagEnabled("PII_REDACTION_ENABLED"),
  };
}

// ─── Core Functions ───────────────────────────────────────────────────

/**
 * @typedef {Object} SanitizeResult
 * @property {boolean} blocked - Whether the request should be blocked
 * @property {boolean} modified - Whether the content was modified (PII redacted)
 * @property {Array<{pattern: string, severity: string, match: string}>} detections
 * @property {Array<{type: string, count: number}>} piiDetections
 * @property {Object} [sanitizedBody] - Modified body (if PII redaction active)
 */

/**
 * Extract all message content strings from a chat body.
 * Supports both `messages[]` (OpenAI/Claude) and `input[]` (Responses API).
 * @param {Object} body
 * @returns {string[]}
 */
function extractMessageContents(body) {
  const contents = [];

  const messageSource = body.messages !== undefined ? body.messages : body.input;
  const messages = Array.isArray(messageSource)
    ? messageSource
    : messageSource === undefined || messageSource === null
      ? []
      : [messageSource];
  for (const msg of messages) {
    if (typeof msg === "string") {
      contents.push(msg);
    } else if (msg && typeof msg.content === "string") {
      contents.push(msg.content);
    } else if (msg && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "string") {
          contents.push(part);
        } else if (part.text) {
          contents.push(part.text);
        }
      }
    }
  }

  // Also check system prompt
  if (typeof body.system === "string") {
    contents.push(body.system);
  } else if (Array.isArray(body.system)) {
    for (const s of body.system) {
      if (typeof s === "string") contents.push(s);
      else if (s.text) contents.push(s.text);
    }
  }

  if (typeof body.input === "string") contents.push(body.input);
  if (typeof body.prompt === "string") contents.push(body.prompt);
  else if (Array.isArray(body.prompt))
    for (const p of body.prompt) {
      if (typeof p === "string") contents.push(p);
    }
  if (typeof body.instructions === "string") contents.push(body.instructions);
  if (typeof body.query === "string") contents.push(body.query);
  if (Array.isArray(body.documents))
    for (const d of body.documents) {
      if (typeof d === "string") contents.push(d);
      else if (d && typeof d.text === "string") contents.push(d.text);
    }

  return contents;
}

/**
 * Scan content for prompt injection patterns.
 * @param {string} text
 * @returns {Array<{pattern: string, severity: string, match: string}>}
 */
function detectInjection(text) {
  const detections = [];
  // Bound the regex scan to MAX_INJECTION_SCAN_BYTES — see constant above
  // (hot-path perf, #3932 / #4041). Slice before the loop so each pattern only
  // ever scans the capped prefix, never the full (possibly hundreds of KB) body.
  const scanText =
    text.length > MAX_INJECTION_SCAN_BYTES ? text.slice(0, MAX_INJECTION_SCAN_BYTES) : text;
  for (const rule of INJECTION_PATTERNS) {
    const match = scanText.match(rule.pattern);
    if (match) {
      detections.push({
        pattern: rule.name,
        severity: rule.severity,
        match: match[0].slice(0, 50), // truncate for logging
      });
    }
  }
  return detections;
}

/**
 * Scan and optionally redact PII from text.
 * @param {string} text
 * @param {boolean} redact - If true, replaces PII with placeholders
 * @returns {{ text: string, detections: Array<{type: string, count: number}> }}
 */
function processPII(text, redact = false) {
  const detections = [];
  let processed = text;

  for (const rule of PII_PATTERNS) {
    const matches = text.match(rule.pattern);
    if (matches && matches.length > 0) {
      detections.push({ type: rule.name, count: matches.length });
      if (redact) {
        processed = processed.replace(rule.pattern, rule.replacement);
      }
    }
  }

  return { text: processed, detections };
}

/**
 * Sanitize a chat request body.
 *
 * @param {Object} body - The chat completion request body
 * @param {Object} [logger] - Logger instance (defaults to console)
 * @returns {SanitizeResult}
 */
export function sanitizeRequest(body, logger = console) {
  const config = getConfig();

  const result = {
    blocked: false,
    modified: false,
    detections: [],
    piiDetections: [],
    sanitizedBody: null,
  };

  if (!config.enabled) return result;

  const contents = extractMessageContents(body);
  const fullText = contents.join("\n");

  // ── Prompt Injection Detection ──
  const injections = detectInjection(fullText);
  if (injections.length > 0) {
    result.detections = injections;

    const highSeverity = injections.filter((d) => d.severity === "high");
    const logLevel = highSeverity.length > 0 ? "warn" : "info";

    if (logger[logLevel]) {
      logger[logLevel](
        `[SANITIZER] Prompt injection detected: ${injections.map((d) => d.pattern).join(", ")}`
      );
    }

    if (config.mode === "block" && highSeverity.length > 0) {
      result.blocked = true;
      return result;
    }
  }

  // ── PII Detection / Redaction ──
  if (config.piiRedaction) {
    const piiResult = processPII(fullText, config.mode === "redact");
    result.piiDetections = piiResult.detections;

    if (piiResult.detections.length > 0) {
      logger.warn?.(
        `[SANITIZER] PII detected: ${piiResult.detections.map((d) => `${d.type}(${d.count})`).join(", ")}`
      );

      if (config.mode === "redact") {
        // Deep clone and replace message contents with redacted versions
        result.sanitizedBody = redactBody(body);
        result.modified = true;
      }
    }
  }

  return result;
}

/**
 * Deep clone body and replace message contents with PII-redacted versions.
 * @param {Object} body
 * @returns {Object}
 */
function redactBody(body) {
  const clone = JSON.parse(JSON.stringify(body));
  const messageSource = clone.messages !== undefined ? clone.messages : clone.input;
  const messages = Array.isArray(messageSource)
    ? messageSource
    : messageSource && typeof messageSource === "object"
      ? [messageSource]
      : [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      msg.content = processPII(msg.content, true).text;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "string") {
          const idx = msg.content.indexOf(part);
          msg.content[idx] = processPII(part, true).text;
        } else if (part.text) {
          part.text = processPII(part.text, true).text;
        }
      }
    }
  }

  if (typeof clone.system === "string") {
    clone.system = processPII(clone.system, true).text;
  }

  return clone;
}

// ─── Exports for Testing ──────────────────────────────────────────────

export { detectInjection, processPII, extractMessageContents, INJECTION_PATTERNS, PII_PATTERNS };
