import { defineAgent } from "eve";
import { reviewModel } from "@/model";

export default defineAgent({
  model: reviewModel,
  modelContextWindowTokens: 64_000,
});
