import { createOctokit } from "@github-tools/sdk";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";
import { githubToken } from "@/github";
import { currentPullRequest, samePullRequest } from "@/github-context";

const invocation = z.object({
  authenticator: z.literal("github-webhook"),
  attributes: z.object({ repository: z.string().regex(/^[^/]+\/[^/]+$/) }),
});

const repository = z.object({ owner: z.string().min(1), repo: z.string().min(1) });

const pullRequestWrite = z.union([
  repository.extend({ pullNumber: z.number() }),
  repository
    .extend({ issueNumber: z.number() })
    .transform(({ issueNumber, ...rest }) => ({ ...rest, pullNumber: issueNumber })),
]);

const fileWrite = repository.extend({ branch: z.string().min(1) });

const headBranch = z.object({
  state: z.string(),
  head: z.object({
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
});

function blocked(reason: string): ApprovalStatus {
  return { type: "denied", reason: `Write blocked: ${reason}` };
}

export function approveRepositoryWrite(ctx: ApprovalContext): ApprovalStatus {
  const signed = invocation.safeParse(ctx.session.auth.current);
  const input = repository.safeParse(ctx.toolInput);

  if (
    !signed.success ||
    !input.success ||
    `${input.data.owner}/${input.data.repo}`.toLowerCase() !==
      signed.data.attributes.repository.toLowerCase()
  ) {
    return blocked("target the signed webhook's repository.");
  }

  return "not-applicable";
}

// Labels, PR edits, summaries, replies, and reviewer requests act on one PR or
// issue number, which must be the signed webhook's PR.
export function approvePullRequestWrite(ctx: ApprovalContext): ApprovalStatus {
  const target = currentPullRequest(ctx);
  const input = pullRequestWrite.safeParse(ctx.toolInput);

  if (!target || !input.success || !samePullRequest(target, input.data)) {
    return blocked("target the signed webhook's pull request.");
  }

  return "not-applicable";
}

// createOrUpdateFile commits to the default branch when `branch` is omitted and
// otherwise accepts any branch. Fixes may only commit to the current PR's head
// branch, and only when that branch lives in the signed repository: a fork's
// head ref names a branch in the fork, so the same name here is another branch.
export async function approveFileWrite(ctx: ApprovalContext): Promise<ApprovalStatus> {
  const target = currentPullRequest(ctx);
  const input = fileWrite.safeParse(ctx.toolInput);

  if (
    !target ||
    !input.success ||
    !samePullRequest(target, { ...input.data, pullNumber: target.pullNumber })
  ) {
    return blocked("commit only to the signed webhook PR's head branch.");
  }

  try {
    ctx.abortSignal.throwIfAborted();
    // SDK 1.18's getPullRequest omits the head repository; its public Octokit
    // client returns it, so fork heads can be told apart from same-repo branches.
    const octokit = createOctokit(await githubToken({ toolName: ctx.toolName, ...target }));

    const { data } = await octokit.rest.pulls.get({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.pullNumber,
      request: { signal: ctx.abortSignal },
    });

    const pr = headBranch.parse(data);

    ctx.abortSignal.throwIfAborted();

    if (pr.state !== "open") {
      return blocked("the PR is no longer open.");
    }

    if (pr.head.repo?.full_name.toLowerCase() !== `${target.owner}/${target.repo}`.toLowerCase()) {
      return blocked("the PR head is in a fork or a deleted repository; post findings instead.");
    }

    if (pr.head.ref !== input.data.branch) {
      return blocked(`commit only to the PR's head branch "${pr.head.ref}".`);
    }

    return "not-applicable";
  } catch {
    return blocked("the PR's head branch could not be verified.");
  }
}
