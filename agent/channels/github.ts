import { githubChannel, defaultGitHubAuth } from "eve/channels/github";
import { env } from "@/env";

export default githubChannel({
  botName: "aranlucas-pr-bot",

  credentials: {
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  },
  onPullRequest: (ctx, pr) => (pr.action === "opened" ? { auth: defaultGitHubAuth(ctx) } : null),
});
