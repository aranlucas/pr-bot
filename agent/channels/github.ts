import { githubChannel, defaultGitHubAuth } from "eve/channels/github";
import type { GitHubChannelEvents } from "eve/channels/github";
import { z } from "zod";
import { executeGithubEveTool } from "@github-tools/sdk/eve-runtime";
import { env } from "@/env";
import { githubToken } from "@/github";
import { botName, pausedLabel } from "@/merge-assessment";

const automaticReview = z.object({
  state: z.literal("open"),
  merged: z.literal(false),
  draft: z.literal(false),
  labels: z.array(z.object({ name: z.string() })),
});

export const githubEvents: GitHubChannelEvents = {
  async "message.completed"(event, channel) {
    // PR comments are published explicitly through the GitHub extension.
    // A final response can explain a silent exit or repeat a posted review.
    if (
      channel.conversation.kind === "issue" &&
      event.finishReason !== "tool-calls" &&
      event.message
    ) {
      await channel.thread.post(event.message);
    }
  },
};

if (env.SANDBOX_ENABLED !== true) {
  // Replacing this event skips Eve's automatic repository checkout.
  Object.assign(githubEvents, {
    async "turn.started"(_event, channel) {
      try {
        await channel.thread.react("eyes");
      } catch {
        // Progress reactions must not prevent a review from starting.
      }
    },
  } satisfies GitHubChannelEvents);
}

export default githubChannel({
  botName,
  credentials: {
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  },
  events: githubEvents,
  async onComment(ctx, comment) {
    if (!new RegExp(`@${botName}(?=$|[^A-Za-z0-9_-])`, "iu").test(comment.body)) {
      return null;
    }

    if (ctx.conversation.pullRequestNumber !== null) {
      try {
        automaticReview.pick({ state: true, merged: true, draft: true }).parse(
          await executeGithubEveTool(
            "getPullRequest",
            {
              owner: ctx.repository.owner,
              repo: ctx.repository.name,
              pullNumber: ctx.conversation.pullRequestNumber,
            },
            { token: githubToken },
          ),
        );
      } catch {
        return null;
      }
    }

    return { auth: defaultGitHubAuth(ctx) };
  },
  onPullRequest(ctx, pr) {
    if (!["opened", "reopened", "ready_for_review", "synchronize"].includes(pr.action)) {
      return null;
    }

    const candidate = automaticReview.safeParse(pr.raw);

    if (
      !candidate.success ||
      pr.headSha === null ||
      candidate.data.labels.some((label) => label.name.toLowerCase() === pausedLabel)
    ) {
      return null;
    }

    return {
      auth: defaultGitHubAuth(ctx),
      context: [
        `Automatic review: ${pr.action}, event head ${pr.headSha}. Refresh the PR before reviewing. If this event was superseded or this head already has a completed bot review, finish silently. Otherwise reconcile previous findings and review new changes.`,
      ],
    };
  },
});
