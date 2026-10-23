import { createOctokit } from "@github-tools/sdk";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { githubBotLogin, githubToken } from "@/github";
import { currentPullRequest, mergeAssessment } from "@/merge-assessment";
import { approveMerge } from "@/merge-policy";

const autoMergeState = z.object({
  repository: z.object({
    autoMergeAllowed: z.boolean(),
    pullRequest: z.object({
      id: z.string(),
      headRefOid: z.string(),
      state: z.literal("OPEN"),
      isDraft: z.literal(false),
      mergeStateStatus: z.string(),
      reviews: z.object({
        nodes: z.array(z.object({ state: z.string(), commit: z.object({ oid: z.string() }) })),
      }),
      baseRef: z
        .object({
          branchProtectionRule: z
            .object({
              requiresApprovingReviews: z.boolean(),
              dismissesStaleReviews: z.boolean(),
              requiredApprovingReviewCount: z.number(),
            })
            .nullable(),
        })
        .nullable(),
    }),
  }),
});

export default defineTool({
  description:
    "Check merge readiness after publishing a clean approval. Queue GitHub squash auto-merge while required approvals or checks are pending; requires repository auto-merge and branch protection that dismisses stale approvals. For queued results, update the existing summary to confirm GitHub owns the wait, then finish. A ready result permits trying the native squash merge tool. For blocked results, update the summary with the reason and finish. A merged result ends the turn immediately.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    // SDK 1.18 has no auto-merge tool; its public Octokit client covers the
    // missing GraphQL operation without adding a second GitHub client library.
    const target = currentPullRequest(ctx);

    if (!target) {
      return { status: "blocked", reason: "A signed GitHub PR invocation is required." };
    }

    const decision = await approveMerge(
      {
        ...ctx,
        approvedTools: new Set<string>(),
        toolInput: { ...target, mergeMethod: "squash" },
      },
      true,
    );

    if (decision !== "not-applicable") {
      return {
        status: "blocked",
        reason: decision.reason,
      };
    }

    const recorded = mergeAssessment.get();

    if (!recorded) {
      return { status: "blocked", reason: "The review assessment is missing." };
    }

    try {
      ctx.abortSignal.throwIfAborted();
      const octokit = createOctokit(await githubToken({ toolName: ctx.toolName, ...target }));

      const state = autoMergeState.safeParse(
        await octokit.graphql(
          `
        query AutoMergeReadiness($owner: String!, $repo: String!, $pullNumber: Int!, $botLogin: String!) {
          repository(owner: $owner, name: $repo) {
            autoMergeAllowed
            pullRequest(number: $pullNumber) {
              id headRefOid state isDraft mergeStateStatus
              reviews(last: 1, author: $botLogin) { nodes { state commit { oid } } }
              baseRef { branchProtectionRule {
                requiresApprovingReviews dismissesStaleReviews requiredApprovingReviewCount
              } }
            }
          }
        }
      `,
          { ...target, botLogin: await githubBotLogin(), request: { signal: ctx.abortSignal } },
        ),
      );

      if (!state.success) {
        return {
          status: "blocked",
          reason: "Current GitHub merge readiness could not be verified.",
        };
      }

      const pr = state.data.repository.pullRequest;

      if (pr.headRefOid !== recorded.assessment.headSha) {
        return { status: "blocked", reason: "The PR head changed; review the new changes." };
      }

      const review = pr.reviews.nodes.at(-1);

      if (review?.state !== "APPROVED" || review.commit.oid !== pr.headRefOid) {
        return {
          status: "blocked",
          reason: "Publish a clean approval for the current head before merging.",
        };
      }

      if (pr.mergeStateStatus === "CLEAN") {
        const ready = await approveMerge({
          ...ctx,
          approvedTools: new Set<string>(),
          toolInput: { ...target, mergeMethod: "squash" },
        });

        return ready === "not-applicable"
          ? { status: "ready", reason: "Use the native squash merge tool; it rechecks readiness." }
          : { status: "blocked", reason: "CI must finish successfully before an immediate merge." };
      }

      const protection = pr.baseRef?.branchProtectionRule;

      if (
        pr.mergeStateStatus !== "BLOCKED" ||
        !state.data.repository.autoMergeAllowed ||
        !protection?.requiresApprovingReviews ||
        !protection.dismissesStaleReviews ||
        protection.requiredApprovingReviewCount < 1
      ) {
        return {
          status: "blocked",
          reason:
            "Queueing requires repository auto-merge, a blocked PR, and branch protection requiring approvals and dismissing stale reviews.",
        };
      }

      ctx.abortSignal.throwIfAborted();

      const result = z
        .object({
          enablePullRequestAutoMerge: z.object({
            pullRequest: z.object({
              merged: z.boolean(),
              autoMergeRequest: z.object({ mergeMethod: z.literal("SQUASH") }).nullable(),
            }),
          }),
        })
        .parse(
          await octokit.graphql(
            `
        mutation EnableAutoMerge($input: EnablePullRequestAutoMergeInput!) {
          enablePullRequestAutoMerge(input: $input) {
            pullRequest { merged autoMergeRequest { mergeMethod } }
          }
        }
      `,
            {
              input: {
                pullRequestId: pr.id,
                expectedHeadOid: pr.headRefOid,
                mergeMethod: "SQUASH",
              },
              request: { signal: ctx.abortSignal },
            },
          ),
        );

      const queued = result.enablePullRequestAutoMerge.pullRequest;

      if (queued.merged) {
        return { status: "merged" };
      }

      return queued.autoMergeRequest
        ? { status: "queued", mergeMethod: queued.autoMergeRequest.mergeMethod }
        : { status: "blocked", reason: "GitHub returned no active auto-merge request." };
    } catch {
      return {
        status: "blocked",
        reason: "GitHub auto-merge could not be confirmed; inspect the PR before retrying.",
      };
    }
  },
  endsTurn: (output) => output.status === "merged",
});
