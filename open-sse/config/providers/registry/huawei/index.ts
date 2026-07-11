import type { RegistryEntry } from "../../shared.ts";

/**
 * Huawei Cloud ModelArts — International
 *
 * Pangu (盘古) series models via OpenAI-compatible endpoint.
 * Huawei Cloud ModelArts provides an OpenAI-compatible inference API
 * for deploying and calling Pangu foundational models.
 *
 * API Docs: https://support.huaweicloud.com/en-us/product-modelarts.html
 * Endpoint: https://ma-api.{region}.myhuaweicloud.com/v1/chat/completions
 */
export const huaweiProvider: RegistryEntry = {
  id: "huawei",
  alias: "huawei",
  format: "openai",
  executor: "default",
  baseUrl:
    "https://infer-modelarts.cn-north-4.myhuaweicloud.com/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: [
    // Pangu (盘古) Large Models
    {
      id: "pangu-ultra",
      name: "Pangu Ultra",
      contextLength: 131072,
    },
    {
      id: "pangu-pro",
      name: "Pangu Pro",
      contextLength: 131072,
    },
    {
      id: "pangu-base",
      name: "Pangu Base",
      contextLength: 32768,
    },
    // Pangu-NLP Series
    {
      id: "pangu-nlp-72b",
      name: "Pangu NLP 72B",
      contextLength: 32768,
    },
    // Pangu-Multimodal
    {
      id: "pangu-vision",
      name: "Pangu Vision",
      contextLength: 8192,
    },
    // Semantic models
    {
      id: "semantic-ultra",
      name: "Semantic Ultra",
      contextLength: 131072,
    },
    {
      id: "semantic-pro",
      name: "Semantic Pro",
      contextLength: 32768,
    },
  ],
};
