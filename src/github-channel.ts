import { POST } from "eve/channels";
import {
  githubChannel,
  type GitHubChannelConfig,
  type GitHubChannelState,
  type GitHubInboundContext,
} from "eve/channels/github";
import { config, repositoryAllowed, required } from "@/config";
import { createGitHub, type Target } from "@/github";
import { parseEvent, pullRequestActions, verifySignature } from "@/webhook";

export function reviewAuth(target: Target) {
  return {
    authenticator: "github-app",
    principalType: "service" as const,
    principalId: target.repository,
    attributes: {
      repository: target.repository,
      number: String(target.number),
      delivery: target.delivery,
      installationId: String(target.installationId),
    },
  };
}

function onPullRequest(ctx: GitHubInboundContext, action: string, number: number) {
  const repository = ctx.repository.fullName.toLowerCase();
  const installationId = ctx.github.installationId;

  if (
    !installationId ||
    !pullRequestActions.includes(action) ||
    !repositoryAllowed(repository, config())
  ) {
    return null;
  }

  return { auth: reviewAuth({ repository, number, delivery: ctx.delivery.id, installationId }) };
}

export function createReviewChannel(options?: Pick<GitHubChannelConfig, "api" | "credentials">) {
  const channel = githubChannel({
    ...options,
    turnPolicy: "queue",
    onComment: () => null,
    onPullRequest: (ctx, pr) => onPullRequest(ctx, pr.action, pr.pullRequestNumber),
    events: {
      // Reviews fetch complete diffs through Octokit; they do not need a sandbox checkout.
      "turn.started": () => {},
    },
  });

  const receive = channel.receive;

  if (!receive) {
    throw new Error("The GitHub channel must support proactive PR sessions");
  }

  return {
    ...channel,
    routes: channel.routes.map((route) => {
      if (route.transport === "websocket") {
        return route;
      }

      return POST<GitHubChannelState>(route.path, async (request, args) => {
        const name = request.headers.get("x-github-event") ?? "";

        // Eve handles PR events. These triggers need review/status support and all PR associations.
        if (!["pull_request_review", "status", "check_run", "check_suite"].includes(name)) {
          return route.handler(request, args);
        }

        const raw = Buffer.from(await request.arrayBuffer());

        const signatureValid = await verifySignature(
          raw,
          request.headers.get("x-hub-signature-256"),
          required("GITHUB_WEBHOOK_SECRET"),
        );

        if (!signatureValid) {
          return new Response("Invalid signature", { status: 401 });
        }

        const delivery = request.headers.get("x-github-delivery");

        if (!delivery) {
          return new Response("Missing delivery ID", { status: 400 });
        }

        let event;

        try {
          event = parseEvent(name, raw.toString("utf8"));
        } catch {
          return new Response("Invalid event payload", { status: 400 });
        }

        if (!event) {
          return Response.json({ ignored: true });
        }

        if (!repositoryAllowed(event.repository, config())) {
          return new Response("Repository not allowed", { status: 403 });
        }

        const numbers = event.numbers.length
          ? event.numbers
          : event.sha
            ? await createGitHub({ installationId: event.installationId }).prsForCommit(
                event.repository,
                event.sha,
              )
            : [];

        const [owner, repo] = event.repository.split("/");

        const sessions = await Promise.all(
          [...new Set(numbers)].map(async (number) => {
            const session = await receive(
              {
                target: {
                  owner,
                  repo,
                  repositoryId: event.repositoryId,
                  installationId: event.installationId,
                  pullRequestNumber: number,
                },
                message:
                  "Review the current verified PR context and post your findings with post-comment.",
                auth: reviewAuth({ ...event, number, delivery }),
              },
              args,
            );

            return session.id;
          }),
        );

        return Response.json({ accepted: true, sessions }, { status: 202 });
      });
    }),
  };
}
