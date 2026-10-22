import { defineAgent } from "eve";
import { env } from "@/env";
import { reviewModel } from "@/model";

export default defineAgent({
  defaultTools: env.SANDBOX_ENABLED === true,
  model: reviewModel,
  modelContextWindowTokens: 64_000,
  compaction: { thresholdPercent: 0.75 },
});
