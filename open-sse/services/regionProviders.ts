/**
 * Region Provider Classification — 区域服务商分类
 *
 * Classifies AI providers as "domestic" (data stays within mainland China)
 * or "overseas" for region-aware routing decisions.
 *
 * When AIRROUTE_REGION=cn, the scoring engine boosts domestic providers via
 * the `regionAffinity` factor (see scoring.ts), because:
 *   1. Lower cross-border latency (GFW adds 100-300ms RTT + packet loss)
 *   2. PIPL/DSL compliance (data stays in China, no 安全评估 / 标准合同 needed)
 *   3. Service stability (overseas APIs subject to GFW disruptions)
 *   4. Price competitiveness (domestic models are often 3-10x cheaper)
 *
 * @module services/regionProviders
 */

// ── Domestic Provider IDs ──
// These provider IDs correspond to services whose API endpoints resolve to
// mainland China IP addresses.  The set is synchronized with the domain-level
// DOMESTIC_DOMAINS in dataExportControl.ts — if you add a provider here,
// make sure its domain(s) are also listed there.

const DOMESTIC_PROVIDER_IDS = new Set([
  // Alibaba / Qwen / DashScope / Tongyi
  "qwen",
  "dashscope",
  "tongyi",
  "aliyun",
  // Baidu / Qianfan / Wenxin
  "qianfan",
  "baidu",
  "wenxin",
  // Tencent / Hunyuan
  "hunyuan",
  "tencent",
  // Huawei Cloud / Pangu (China region only — huawei-cn)
  "huawei-cn",
  "pangu",
  // iFlytek / Spark
  "spark",
  "iflytek",
  "xinghuo",
  // DeepSeek
  "deepseek",
  // Moonshot / Kimi
  "moonshot",
  "kimi",
  // ByteDance / Doubao / Volcengine / Ark
  "doubao",
  "volcengine",
  "volc",
  // Baichuan
  "baichuan",
  // Minimax
  "minimax",
  "abab",
  // SenseNova
  "sensenova",
  // StepFun
  "stepfun",
  "step",
  // Zhipu / GLM / ChatGLM
  "zhipu",
  "glm",
  "chatglm",
  "bigmodel",
  // 360 AI
  "360",
  "360gpt",
  // SiliconFlow
  "siliconflow",
  // Qiniu
  "qiniu",
  // Xiaomi MiMo
  "mimo",
  // ModelScope
  "modelscope",
  // Coze (China instance)
  "coze-cn",
  "coze-bot",       // Coze Bot Agent (uses api.coze.cn when AIRROUTE_REGION=cn)
  // Dify (typically self-hosted in China)
  "dify-workflow",  // Dify Workflow App (self-hosted, CN endpoint likely domestic)
  // Yi (零一万物)
  "yi",
  "lingyi",
  // Jina (China mirror not applicable, but listed for completeness)
]);

// ── Overseas Provider IDs (explicitly NOT domestic) ──
// Used for logging/debugging.  Providers not in either set are treated
// as unknown (regionAffinity = 0.5 — neutral).

const OVERSEAS_PROVIDER_IDS = new Set([
  "openai",
  "anthropic",
  "google",
  "gemini",
  "vertex",
  "azure",
  "azure-openai",
  "aws",
  "bedrock",
  "mistral",
  "cohere",
  "together",
  "fireworks",
  "groq",
  "openrouter",
  "perplexity",
  "xai",
  "grok",
  "replicate",
  "deepinfra",
  "huggingface",
  "novita",
  "lepton",
  "sambanova",
  "cerebras",
  "ai21",
  "jamba",
  // Huawei international (not huawei-cn)
  "huawei",
]);

/**
 * Check if a provider ID is classified as domestic (China).
 * Returns true if the provider's API endpoints resolve to mainland China IPs.
 */
export function isDomesticProviderId(providerId: string): boolean {
  if (!providerId) return false;
  const normalized = providerId.toLowerCase().trim();
  if (DOMESTIC_PROVIDER_IDS.has(normalized)) return true;
  // Handle compound IDs like "qwen/qwen-max" or "deepseek-chat"
  for (const domestic of DOMESTIC_PROVIDER_IDS) {
    if (normalized.startsWith(domestic + "-") || normalized.startsWith(domestic + "/")) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a provider ID is explicitly classified as overseas.
 * Returns true if the provider is known to be outside China.
 */
export function isOverseasProviderId(providerId: string): boolean {
  if (!providerId) return false;
  const normalized = providerId.toLowerCase().trim();
  return OVERSEAS_PROVIDER_IDS.has(normalized);
}

/**
 * Calculate region affinity score for a provider.
 * - Domestic providers: 1.0 (full affinity — preferred in China region)
 * - Overseas providers: 0.0 (no affinity — penalized in China region)
 * - Unknown providers: 0.5 (neutral — no preference)
 */
export function calculateRegionAffinity(providerId: string): number {
  if (isDomesticProviderId(providerId)) return 1.0;
  if (isOverseasProviderId(providerId)) return 0.0;
  return 0.5;
}

/**
 * Get the set of all domestic provider IDs (for admin UI / diagnostics).
 */
export function getDomesticProviderIds(): string[] {
  return [...DOMESTIC_PROVIDER_IDS].sort();
}

/**
 * Get the set of all overseas provider IDs (for admin UI / diagnostics).
 */
export function getOverseasProviderIds(): string[] {
  return [...OVERSEAS_PROVIDER_IDS].sort();
}

/**
 * Resolve the effective region for routing decisions.
 * Reads AIRROUTE_REGION env var; returns "cn" | "global".
 */
export function resolveRegion(): "cn" | "global" {
  return process.env.AIRROUTE_REGION === "cn" ? "cn" : "global";
}
