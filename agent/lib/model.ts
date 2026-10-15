import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const freellmapi = createOpenAICompatible({
  name: "freellmapi",
  baseURL:
    process.env.FREELLM_API_BASE_URL ?? "https://freellmapi-production-1175.up.railway.app/v1",
  apiKey: process.env.FREELLM_API_KEY ?? "",
  supportsStructuredOutputs: true,
  // The SDK's tool loop can replace provider headers, so identify the agent
  // after those headers are merged, while preserving SDK diagnostics.
  fetch: (url, init) => {
    const headers = new Headers(init?.headers);
    const sdkUserAgent = headers.get("user-agent");
    headers.set(
      "user-agent",
      ["pr-bot (Eve agent; OpenAI-compatible)", sdkUserAgent].filter(Boolean).join(" "),
    );

    return globalThis.fetch(url, { ...init, headers });
  },
});

export const reviewModel = freellmapi(process.env.FREELLM_MODEL ?? "auto");
