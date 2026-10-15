import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const freellmapi = createOpenAICompatible({
  name: "freellmapi",
  baseURL:
    process.env.FREELLM_API_BASE_URL ?? "https://freellmapi-production-1175.up.railway.app/v1",
  apiKey: process.env.FREELLM_API_KEY ?? "",
  supportsStructuredOutputs: true,
});

export const reviewModel = freellmapi(process.env.FREELLM_MODEL ?? "auto");
