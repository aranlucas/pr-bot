import { defineAgent } from "eve";
import { reviewModel } from "@/model";

export default defineAgent({
  model: reviewModel,
  defaultTools: false,
  tool: false,
  modelContextWindowTokens: 64_000,
});
