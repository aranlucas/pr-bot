import { defaultGitHubAuth, githubChannel } from "eve/channels/github";
import { githubInstallation } from "@/github";

export default githubChannel({
  turnPolicy: "queue",
  onComment: () => null,
  onPullRequest: (ctx, pr) =>
    ["opened", "reopened", "synchronize", "ready_for_review", "edited"].includes(pr.action)
      ? { auth: defaultGitHubAuth(ctx) }
      : null,
  onCheckRun: (ctx, check) =>
    check.action === "completed" && check.pullRequests.length > 0
      ? { auth: defaultGitHubAuth(ctx) }
      : null,
  onCheckSuite: (ctx, suite) =>
    suite.action === "completed" && suite.pullRequests.length > 0
      ? { auth: defaultGitHubAuth(ctx) }
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
