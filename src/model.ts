import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export function freeModelId(value = process.env.OPENROUTER_MODEL ?? "openrouter/free"): string {
  if (value !== "openrouter/free" && !value.endsWith(":free")) {
    throw new Error("OPENROUTER_MODEL must use openrouter/free or a :free model");
  }

  return value;
}

const openrouter = createOpenAICompatible({
  name: "openrouter",
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  supportsStructuredOutputs: true,
  transformRequestBody: (body) => ({
    ...body,
    provider: { require_parameters: true, max_price: { prompt: 0, completion: 0 } },
  }),
});

export const reviewModel = openrouter(freeModelId());
