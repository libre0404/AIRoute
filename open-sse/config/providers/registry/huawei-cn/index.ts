import type { RegistryEntry } from "../../shared.ts";

/**
 * Huawei Cloud ModelArts — China (华为云 ModelArts 中国区)
 *
 * Pangu (盘古) series models via OpenAI-compatible endpoint.
 * Uses China-region endpoints for low latency and data residency compliance.
 *
 * API Docs: https://support.huaweicloud.com/productdesc-modelarts/modelarts_01_0001.html
 * Console: https://console.huaweicloud.com/modelarts/
 *
 * Regions: cn-north-1 (北京一), cn-north-4 (北京四), cn-east-3 (上海),
 *          cn-south-1 (广州), cn-southwest-2 (贵阳)
 *
 * Note: Users must deploy models on ModelArts first, then use the
 * generated endpoint URL. The baseUrl here is the default cn-north-4.
 * Users can override via connection settings for other regions.
 */
export const huaweiCnProvider: RegistryEntry = {
  id: "huawei-cn",
  alias: "huawei-cn",
  format: "openai",
  executor: "default",
  baseUrl:
    "https://infer-modelarts.cn-north-4.myhuaweicloud.com/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: [
    // 盘古大模型系列 (Pangu Series)
    {
      id: "pangu-ultra",
      name: "盘古 Ultra",
      contextLength: 131072,
    },
    {
      id: "pangu-pro",
      name: "盘古 Pro",
      contextLength: 131072,
    },
    {
      id: "pangu-base",
      name: "盘古 Base",
      contextLength: 32768,
    },
    // 盘古自然语言处理
    {
      id: "pangu-nlp-72b",
      name: "盘古 NLP 72B",
      contextLength: 32768,
    },
    // 盘古多模态
    {
      id: "pangu-vision",
      name: "盘古视觉",
      contextLength: 8192,
    },
    // 盘古科学计算
    {
      id: "pangu-weather",
      name: "盘古气象",
      contextLength: 8192,
    },
    // 语义模型
    {
      id: "semantic-ultra",
      name: "语义 Ultra",
      contextLength: 131072,
    },
    {
      id: "semantic-pro",
      name: "语义 Pro",
      contextLength: 32768,
    },
  ],
};
