import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
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

export const reviewModel = wrapLanguageModel({
  model: freellmapi(env.FREELLM_MODEL),
  middleware: {
    transformParams: ({ params }) =>
      Promise.resolve({
        ...params,
        // Leave time for compaction, tools, and failure reporting within the
        // 300-second function limit, while preserving Eve's cancellation signal.
        abortSignal: AbortSignal.any([
          ...(params.abortSignal ? [params.abortSignal] : []),
          AbortSignal.timeout(90_000),
        ]),
      }),
  },
});
