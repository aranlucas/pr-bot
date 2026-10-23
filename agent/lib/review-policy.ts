import { executeGithubEveTool } from "@github-tools/sdk/eve-runtime";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";
import { githubToken } from "@/github";
import { approveMerge } from "@/merge-policy";
import {
  currentPullRequest,
  mergeAssessment,
  mergePolicyVersion,
  samePullRequest,
} from "@/merge-assessment";

const reviewTarget = z.object({
  owner: z.string(),
  repo: z.string(),
  pullNumber: z.number(),
  event: z.enum(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
});

const currentHead = z.object({
  headSha: z.string(),
  state: z.string(),
  merged: z.boolean(),
  draft: z.boolean(),
});

export async function approveReview(ctx: ApprovalContext): Promise<ApprovalStatus> {
  const target = currentPullRequest(ctx);
  const input = reviewTarget.safeParse(ctx.toolInput);

  if (!target || !input.success || !samePullRequest(target, input.data)) {
    return { type: "denied", reason: "Review blocked: target the current signed webhook's PR." };
  }

  const recorded = mergeAssessment.get();

  if (
    !recorded ||
    recorded.policyVersion !== mergePolicyVersion ||
    recorded.turnId !== ctx.session.turn.id ||
    !samePullRequest(recorded.target, target)
  ) {
    return {
      type: "denied",
      reason: "Review blocked: record an assessment in this turn before publishing.",
    };
  }

  try {
    ctx.abortSignal.throwIfAborted();

    const fresh = currentHead.parse(
      await executeGithubEveTool("getPullRequest", { ...target }, { token: githubToken }),
    );

    ctx.abortSignal.throwIfAborted();

    if (
      fresh.state !== "open" ||
      fresh.merged ||
      fresh.draft ||
      fresh.headSha !== recorded.assessment.headSha
    ) {
      return {
        type: "denied",
        reason:
          "Review blocked: the PR closed, merged, became draft, or changed head; refresh and reassess.",
      };
    }

    if (input.data.event === "APPROVE") {
      return await approveMerge({ ...ctx, toolInput: { ...target, mergeMethod: "squash" } }, true);
    }

    return "not-applicable";
  } catch {
    return {
      type: "denied",
      reason: "Review blocked: current PR freshness could not be verified.",
    };
  }
}
