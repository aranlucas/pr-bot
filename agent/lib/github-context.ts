import type { SessionContext } from "eve/context";
import { z } from "zod";

export const botName = "aranlucas-pr-bot";

export const pausedLabel = "pr-bot:paused";

export interface PullRequestTarget {
  owner: string;
  repo: string;
  pullNumber: number;
}

const invocation = z.object({
  authenticator: z.literal("github-webhook"),
  attributes: z.object({
    conversation_kind: z.enum(["pull_request", "review_thread"]),
    repository: z.string().regex(/^[^/]+\/[^/]+$/),
    pull_request_number: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().positive()),
  }),
});

export function currentPullRequest(ctx: SessionContext): PullRequestTarget | undefined {
  const parsed = invocation.safeParse(ctx.session.auth.current);

  if (!parsed.success) {
    return;
  }

  const [owner, repo] = parsed.data.attributes.repository.split("/");

  return { owner, repo, pullNumber: parsed.data.attributes.pull_request_number };
}

export function samePullRequest(a: PullRequestTarget, b: PullRequestTarget): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase() &&
    a.pullNumber === b.pullNumber
  );
}
