import { defineTool } from "eve/tools";
import { z } from "zod";
import { mergePullRequest, verifiedTarget } from "@/review";

export default defineTool({
  description:
    "Merge the verified PR only after post-comment has successfully published your review for this delivery. Call only if your review found no material unresolved defects. Enforces current review content, CI, approvals, branch policy, mergeability, and dry-run mode.",
  inputSchema: z.object({}),
  availableInSubagents: false,
  execute(_input, ctx) {
    return mergePullRequest(verifiedTarget(ctx.session.auth.current));
  },
  endsTurn: true,
});
