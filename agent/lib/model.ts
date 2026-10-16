import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { env } from "@/env";

const freellmapi = createOpenAICompatible({
  name: "freellmapi",
  baseURL: env.FREELLM_API_BASE_URL,
  apiKey: env.FREELLM_API_KEY,
  supportsStructuredOutputs: true,
  headers: {
    "user-agent": "pr-bot (Eve agent; OpenAI-compatible)",
    "HTTP-Referer": "https://github.com/aranlucas/pr-bot",
    "X-OpenRouter-Title": "PR Bot",
    "X-Title": "PR Bot",
  },
});

export const reviewModel = freellmapi(env.FREELLM_MODEL);
