import type { RegistryEntry } from "../../shared.ts";
import { CHAT_OPENAI_COMPAT_MODELS } from "../../shared.ts";

export const moonshotProvider: RegistryEntry = {
  id: "moonshot",
  alias: "moonshot",
  format: "openai",
  executor: "default",
  baseUrl: "https://api.moonshot.ai/v1/chat/completions",
  modelsUrl: "https://api.moonshot.ai/v1/models",
  authType: "apikey",
  authHeader: "bearer",
  passthroughModels: true,
  models: CHAT_OPENAI_COMPAT_MODELS.moonshot,
};
