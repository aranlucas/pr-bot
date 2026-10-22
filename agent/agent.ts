import { defineAgent } from "eve";
import { env } from "@/env";
import { reviewModel } from "@/model";

export default defineAgent({
  defaultTools: env.SANDBOX_ENABLED === true,
  model: reviewModel,
  // Matches FreeLLMAPI's 128k "min context window" routing floor, so every
  // model the `auto` route can pick holds a full window before compaction.
  modelContextWindowTokens: 131_072,
  compaction: { thresholdPercent: 0.75 },
});
