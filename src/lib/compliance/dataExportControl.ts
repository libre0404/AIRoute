/**
 * Data Export Control — 数据出境管控
 *
 * When AIRROUTE_REGION=cn, enforces 《数据安全法》(DSL) §31 and
 * 《个人信息保护法》(PIPL) §38/§39/§40 cross-border data transfer rules:
 *
 * 1. Domain whitelist: only approved overseas domains may receive requests.
 *    Default whitelist covers major LLM providers with demonstrated compliance.
 * 2. Export logging: every cross-border request is logged with timestamp,
 *    provider, model, and originating user for audit trail.
 * 3. Warning mode: can be set to "warn" (log only) or "block" (reject).
 *
 * Configuration:
 *   AIRROUTE_REGION=cn                  — Activate China compliance mode
 *   DATA_EXPORT_CONTROL_MODE=block|warn — "block" rejects, "warn" logs (default: warn)
 *   DATA_EXPORT_WHITELIST=              — Comma-separated extra approved domains
 *
 * @module compliance/dataExportControl
 */

import { isChinaRegion } from "@/shared/utils/featureFlags";

// ── Types ──

export type ExportControlMode = "off" | "warn" | "block";

export interface ExportCheckResult {
  allowed: boolean;
  crossBorder: boolean;
  reason?: string;
  domain?: string;
}

export interface ExportLogEntry {
  timestamp: string;
  provider: string;
  domain: string;
  model: string;
  userId?: string;
  crossBorder: boolean;
  blocked: boolean;
  requestId?: string;
}

// ── Configuration ──

function getControlMode(): ExportControlMode {
  const env = process.env.DATA_EXPORT_CONTROL_MODE;
  if (env === "block" || env === "warn" || env === "off") return env;
  // Default: warn when in China region, off otherwise
  return isChinaRegion() ? "warn" : "off";
}

/**
 * Domestic (China) provider domains — data stays within mainland China.
 * Requests to these domains do NOT constitute cross-border transfer.
 */
const DOMESTIC_DOMAINS = new Set([
  // Alibaba / Qwen
  "dashscope.aliyuncs.com",
  "bailian.console.alibabacloud.com",
  // Baidu / Qianfan
  "qianfan.baidubce.com",
  "aip.baidubce.com",
  "yiyan.baidu.com",
  // Tencent / Hunyuan
  "hunyuan.tencentcloudapi.com",
  "api.hunyuan.tencent.com",
  // Huawei Cloud / Pangu
  "infer-modelarts.cn-north-4.myhuaweicloud.com",
  "infer-modelarts.cn-north-1.myhuaweicloud.com",
  "infer-modelarts.cn-east-3.myhuaweicloud.com",
  "infer-modelarts.cn-south-1.myhuaweicloud.com",
  "infer-modelarts.cn-southwest-2.myhuaweicloud.com",
  // iFlytek / Spark
  "spark-api.xf-yun.com",
  "xinghuo.xfyun.cn",
  // DeepSeek
  "api.deepseek.com",
  // Moonshot / Kimi
  "api.moonshot.cn",
  // ByteDance / Doubao / Volcengine
  "api.volcengine.com",
  "maas-api.cn-beijing.volces.com",
  // Baichuan
  "api.baichuan-ai.com",
  // Minimax
  "api.minimaxi.com",
  "api.minimax.chat",
  // SenseNova
  "api.sensenova.cn",
  // StepFun
  "api.stepfun.com",
  // Zhipu / GLM
  "open.bigmodel.cn",
  "api.z.ai",
  // 360 AI
  "api.360.cn",
  // SiliconFlow
  "api.siliconflow.cn",
  // Qiniu
  "api.qiniu.com",
  // Xiaomi MiMo
  "mimo.mi.com",
  // ModelScope
  "api.modelscope.cn",
  // Coze (China)
  "api.coze.cn",
  // HuggingFace mirror (China)
  "hf-mirror.com",
  // Bing China
  "api.cognitive.microsoft.cn",
]);

/**
 * Whitelisted overseas domains — approved for cross-border transfer
 * (providers with demonstrated data processing compliance / SCCs / certification).
 * Admin can extend via DATA_EXPORT_WHITELIST env var.
 */
const WHITELISTED_OVERSEAS_DOMAINS = new Set([
  // OpenAI (US, SOC 2 Type II, CSA STAR)
  "api.openai.com",
  // Anthropic (US, SOC 2 Type II)
  "api.anthropic.com",
  // Google AI / Gemini
  "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com",
  // Azure OpenAI (data residency options available)
  "*.openai.azure.com",
  // AWS Bedrock (data residency options)
  "bedrock-runtime.*.amazonaws.com",
  // Mistral (EU, GDPR compliant)
  "api.mistral.ai",
  // Cohere (US/SOC 2)
  "api.cohere.com",
  // Together AI
  "api.together.xyz",
  // Fireworks AI
  "api.fireworks.ai",
  // Groq
  "api.groq.com",
  // OpenRouter (aggregator, passes through)
  "openrouter.ai",
]);

/**
 * Parse additional whitelisted domains from DATA_EXPORT_WHITELIST env var.
 */
function getExtraWhitelistedDomains(): Set<string> {
  const extra = process.env.DATA_EXPORT_WHITELIST;
  if (!extra) return new Set();
  return new Set(
    extra
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean)
  );
}

// ── Domain Check ──

/**
 * Check if a domain is domestic (China) or cross-border.
 */
function isDomesticDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (DOMESTIC_DOMAINS.has(d)) return true;
  // Check for Huawei ModelArts regional subdomains
  if (d.endsWith(".myhuaweicloud.com") && d.includes("cn-")) return true;
  // Check for Azure China
  if (d.endsWith(".api.cognitive.microsoft.cn")) return true;
  // Check for Bing China api
  if (d === "api.cognitive.microsoft.cn") return true;
  return false;
}

/**
 * Check if a cross-border domain is whitelisted.
 */
function isWhitelistedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (WHITELISTED_OVERSEAS_DOMAINS.has(d)) return true;
  if (getExtraWhitelistedDomains().has(d)) return true;
  // Wildcard matching for Azure regions (*.openai.azure.com)
  for (const pattern of WHITELISTED_OVERSEAS_DOMAINS) {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // .openai.azure.com
      if (d.endsWith(suffix)) return true;
    }
  }
  return false;
}

// ── Export Log ──

const exportLog: ExportLogEntry[] = [];
const MAX_EXPORT_LOG_SIZE = 10_000;

function logExport(entry: ExportLogEntry): void {
  exportLog.push(entry);
  if (exportLog.length > MAX_EXPORT_LOG_SIZE) {
    exportLog.shift();
  }
  // Also write to console for external log aggregation
  const level = entry.blocked ? "error" : "warn";
  console[level](
    `[DATA_EXPORT] ${entry.blocked ? "BLOCKED" : "CROSS-BORDER"} ` +
      `provider=${entry.provider} domain=${entry.domain} model=${entry.model} ` +
      `user=${entry.userId || "anon"} req=${entry.requestId || "-"}`
  );
}

/**
 * Get recent export log entries for audit dashboard.
 */
export function getExportLog(limit = 100): ExportLogEntry[] {
  return exportLog.slice(-limit);
}

/**
 * Get export log entry count.
 */
export function getExportLogCount(): number {
  return exportLog.length;
}

// ── Public API ──

/**
 * Check if a request to a given domain is allowed under data export control.
 *
 * When AIRROUTE_REGION=cn:
 * - Domestic domains: always allowed
 * - Whitelisted overseas: allowed (logged)
 * - Non-whitelisted overseas: depends on mode (warn=allowed+logged, block=rejected)
 *
 * When not in China region: always allowed (export control off).
 */
export function checkDataExport(params: {
  domain: string;
  provider: string;
  model: string;
  userId?: string;
  requestId?: string;
}): ExportCheckResult {
  const mode = getControlMode();

  // Not in controlled region or explicitly off
  if (mode === "off") {
    return { allowed: true, crossBorder: false };
  }

  const { domain, provider, model, userId, requestId } = params;

  // Domestic — no cross-border transfer
  if (isDomesticDomain(domain)) {
    return { allowed: true, crossBorder: false, domain };
  }

  // Cross-border from here on
  const whitelisted = isWhitelistedDomain(domain);
  const now = new Date().toISOString();

  if (whitelisted) {
    logExport({
      timestamp: now,
      provider,
      domain,
      model,
      userId,
      crossBorder: true,
      blocked: false,
      requestId,
    });
    return { allowed: true, crossBorder: true, domain, reason: "whitelisted" };
  }

  // Non-whitelisted cross-border domain
  if (mode === "block") {
    logExport({
      timestamp: now,
      provider,
      domain,
      model,
      userId,
      crossBorder: true,
      blocked: true,
      requestId,
    });
    return {
      allowed: false,
      crossBorder: true,
      domain,
      reason: `Data export to non-whitelisted domain "${domain}" blocked per 数据安全法 §31. ` +
        `Add to DATA_EXPORT_WHITELIST if this provider has valid cross-border transfer certification (安全评估/标准合同/认证).`,
    };
  }

  // Warn mode — allow but log
  logExport({
    timestamp: now,
    provider,
    domain,
    model,
    userId,
    crossBorder: true,
    blocked: false,
    requestId,
  });
  return {
    allowed: true,
    crossBorder: true,
    domain,
    reason: "Non-whitelisted cross-border domain — logged for audit (DATA_EXPORT_CONTROL_MODE=warn).",
  };
}

/**
 * Get the list of domestic (China) domains.
 */
export function getDomesticDomains(): string[] {
  return [...DOMESTIC_DOMAINS].sort();
}

/**
 * Get the list of whitelisted overseas domains.
 */
export function getWhitelistedOverseasDomains(): string[] {
  return [...WHITELISTED_OVERSEAS_DOMAINS].sort();
}
