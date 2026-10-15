import {
  defaultGitHubAuth,
  githubChannel,
  type GitHubInboundContext,
  type GitHubInboundResult,
} from "eve/channels/github";
import { z } from "zod";
import { githubInstallation } from "@/github";

const pullRequestState = z.object({
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
});

async function dispatchOpenPullRequest(ctx: GitHubInboundContext): Promise<GitHubInboundResult> {
  const pullNumber = ctx.conversation.pullRequestNumber;

  if (pullNumber === null) {
    return null;
  }

  const response = await ctx.github.request({
    method: "GET",
    path: `/repos/${ctx.repository.owner}/${ctx.repository.name}/pulls/${pullNumber}`,
  });

  const pr = pullRequestState.parse(response.body);

  return pr.state === "open" && !pr.merged ? { auth: defaultGitHubAuth(ctx) } : null;
}

export default githubChannel({
  turnPolicy: "queue",
  onComment: () => null,
  onPullRequest: (ctx, pr) =>
    ["opened", "reopened", "synchronize", "ready_for_review", "edited"].includes(pr.action)
      ? dispatchOpenPullRequest(ctx)
      : null,
  onCheckRun: (ctx, check) =>
    check.action === "completed" && check.pullRequests.length > 0
      ? dispatchOpenPullRequest(ctx)
      : null,
  onCheckSuite: (ctx, suite) =>
    suite.action === "completed" && suite.pullRequests.length > 0
      ? dispatchOpenPullRequest(ctx)
      : null,
  events: {
    "turn.started": (_event, channel) => {
      // API-based reviews do not need the channel's default sandbox checkout.
      githubInstallation.update(() => channel.github.installationId ?? null);
    },
    // Reviews are published explicitly through github__addPullRequestComment.
    "message.completed": () => {},
  },
});
