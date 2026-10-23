import { executeGithubEveTool } from "@github-tools/sdk/eve-runtime";
import type { ApprovalContext } from "eve/tools/approval";
import { z } from "zod";
import { githubToken } from "@/github";
import {
  botName,
  currentPullRequest,
  mergeAssessment,
  mergePolicyVersion,
  pausedLabel,
  samePullRequest,
} from "@/merge-assessment";

const mergeInput = z.object({
  owner: z.string(),
  repo: z.string(),
  pullNumber: z.number(),
  mergeMethod: z.literal("squash"),
});

const pullRequest = z.object({
  headSha: z.string(),
  base: z.string(),
  state: z.string(),
  merged: z.boolean(),
  draft: z.boolean(),
  mergeable: z.boolean().nullable(),
});

const review = z.object({
  id: z.number(),
  author: z.string().min(1),
  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
});

const context = z.object({
  pullRequest,
  reviews: z.array(review),
  reviewsHasMore: z.boolean(),
  checks: z.object({
    checkRuns: z.object({
      totalCount: z.number(),
      hasMore: z.boolean(),
      checkRuns: z.array(z.object({ status: z.string(), conclusion: z.string().nullable() })),
    }),
    combinedStatus: z.object({
      state: z.string(),
      totalCount: z.number(),
      statuses: z.array(z.object({ state: z.string() })),
    }),
  }),
});

const issue = z.object({ labels: z.array(z.string()) });

const comparison = z.object({
  totalCommits: z.number().int().positive(),
  commits: z.array(z.object({ author: z.string().optional(), authorLogin: z.string().optional() })),
});

interface DeniedMerge {
  type: "denied";
  reason: string;
}

type MergeDecision = "not-applicable" | DeniedMerge;

function denied(reason: string): DeniedMerge {
  return { type: "denied", reason: `Merge blocked: ${reason}` };
}

export async function approveMerge(
  ctx: ApprovalContext,
  allowPendingChecks = false,
): Promise<MergeDecision> {
  const target = currentPullRequest(ctx);
  const input = mergeInput.safeParse(ctx.toolInput);

  if (!target || !input.success || !samePullRequest(target, input.data)) {
    return denied("only a squash merge of the current signed webhook's PR is allowed.");
  }

  const recorded = mergeAssessment.get();

  if (
    !recorded ||
    recorded.policyVersion !== mergePolicyVersion ||
    recorded.turnId !== ctx.session.turn.id ||
    !samePullRequest(recorded.target, target) ||
    recorded.status !== "eligible"
  ) {
    return denied("record an eligible assessment in this turn before merging.");
  }

  try {
    ctx.abortSignal.throwIfAborted();
    // Use the extension's executor for reads as well; no parallel GitHub client.
    const options = { token: githubToken };

    const [fresh, labels] = await Promise.all([
      executeGithubEveTool(
        "getPullRequestContext",
        { ...target, includeFiles: false, includeReviews: true, includeChecks: true },
        options,
      ).then((result) => context.parse(result)),
      executeGithubEveTool(
        "getIssue",
        { owner: target.owner, repo: target.repo, issueNumber: target.pullNumber },
        options,
      ).then((result) => issue.parse(result)),
    ]);

    const pr = fresh.pullRequest;

    if (pr.headSha !== recorded.assessment.headSha) {
      return denied("the head changed; review and assess the new head.");
    }

    if (pr.state !== "open" || pr.merged || pr.draft || pr.mergeable !== true) {
      return denied("the PR is closed, merged, draft, conflicting, or mergeability is unknown.");
    }

    if (labels.labels.some((label) => label.toLowerCase() === pausedLabel)) {
      return denied("automatic merging is paused for this PR.");
    }

    if (fresh.reviewsHasMore) {
      return denied("review history is incomplete; leave merging to a human.");
    }

    const latest = new Map<string, z.infer<typeof review>>();

    for (const entry of fresh.reviews.toSorted((a, b) => a.id - b.id)) {
      if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(entry.state)) {
        latest.set(entry.author.toLowerCase(), entry);
      }
    }

    if ([...latest.values()].some((entry) => entry.state === "CHANGES_REQUESTED")) {
      return denied("an outstanding review requests changes.");
    }

    const { checkRuns, combinedStatus } = fresh.checks;
    const allowedStatuses = allowPendingChecks ? ["success", "pending"] : ["success"];

    if (
      checkRuns.hasMore ||
      checkRuns.checkRuns.length !== checkRuns.totalCount ||
      combinedStatus.statuses.length !== combinedStatus.totalCount
    ) {
      return denied("CI evidence is incomplete; leave merging to a human.");
    }

    if (
      checkRuns.checkRuns.some((run) =>
        run.status === "completed"
          ? !["success", "neutral", "skipped"].includes(run.conclusion ?? "")
          : !allowPendingChecks ||
            !["queued", "in_progress", "pending", "waiting", "requested"].includes(run.status),
      ) ||
      (combinedStatus.totalCount > 0 &&
        (!allowedStatuses.includes(combinedStatus.state) ||
          combinedStatus.statuses.some((status) => !allowedStatuses.includes(status.state))))
    ) {
      return denied("CI is pending or unsuccessful.");
    }

    const commits = comparison.parse(
      await executeGithubEveTool(
        "compareCommits",
        { owner: target.owner, repo: target.repo, base: pr.base, head: pr.headSha },
        options,
      ),
    );

    if (
      commits.commits.length !== commits.totalCommits ||
      commits.commits.some((commit) => !commit.author && !commit.authorLogin)
    ) {
      return denied("commit authorship evidence is incomplete; leave merging to a human.");
    }

    const botLogin = `${botName}[bot]`;

    if (
      commits.commits.some((commit) =>
        [commit.author, commit.authorLogin].some((author) => author?.toLowerCase() === botLogin),
      )
    ) {
      return denied("this PR contains the bot's commits; a human must review and merge them.");
    }

    ctx.abortSignal.throwIfAborted();

    const final = pullRequest.parse(
      await executeGithubEveTool("getPullRequest", { ...target }, options),
    );

    if (
      final.headSha !== pr.headSha ||
      final.base !== pr.base ||
      final.state !== "open" ||
      final.merged ||
      final.draft ||
      final.mergeable !== true
    ) {
      return denied("the PR changed during readiness checks; refresh and reassess.");
    }

    return "not-applicable";
  } catch {
    return denied("current GitHub readiness could not be verified; leave merging to a human.");
  }
}
