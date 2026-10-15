import { defineTool } from "eve/tools";
import { commentSchema, postComment, verifiedTarget } from "@/review";

export default defineTool({
  description:
    "Post your completed review to the verified webhook PR. Use the reviewId from the current verified PR review context. Reuses the bot's comment for that commit and rejects stale reviews.",
  inputSchema: commentSchema,
  availableInSubagents: false,
  execute(input, ctx) {
    return postComment(verifiedTarget(ctx.session.auth.current), input);
  },
});
