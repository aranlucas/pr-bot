import { createOctokit } from "@github-tools/sdk";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { githubToken } from "@/github";
import { currentPullRequest } from "@/merge-assessment";

export default defineTool({
  description:
    "Disable an existing GitHub auto-merge request on the current PR before pausing reviews. An absent request already counts as disabled. If cancellation cannot be confirmed, report the failure before pausing.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const target = currentPullRequest(ctx);

    if (!target) {
      return { status: "blocked", reason: "A signed GitHub PR invocation is required." };
    }

    try {
      // SDK 1.18 exposes neither auto-merge mutation; use its public client.
      ctx.abortSignal.throwIfAborted();
      const octokit = createOctokit(await githubToken({ toolName: ctx.toolName, ...target }));

      const state = z
        .object({
          repository: z.object({
            pullRequest: z.object({
              id: z.string(),
              autoMergeRequest: z.object({ enabledAt: z.string() }).nullable(),
            }),
          }),
        })
        .parse(
          await octokit.graphql(
            `
        query AutoMergeCancellation($owner: String!, $repo: String!, $pullNumber: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $pullNumber) { id autoMergeRequest { enabledAt } }
          }
        }
      `,
            { ...target, request: { signal: ctx.abortSignal } },
          ),
        );

      const pr = state.repository.pullRequest;

      if (pr.autoMergeRequest) {
        ctx.abortSignal.throwIfAborted();
        z.object({
          disablePullRequestAutoMerge: z.object({
            pullRequest: z.object({
              autoMergeRequest: z.null(),
            }),
          }),
        }).parse(
          await octokit.graphql(
            `
          mutation DisableAutoMerge($input: DisablePullRequestAutoMergeInput!) {
            disablePullRequestAutoMerge(input: $input) {
              pullRequest { autoMergeRequest { enabledAt } }
            }
          }
        `,
            { input: { pullRequestId: pr.id }, request: { signal: ctx.abortSignal } },
          ),
        );
      }

      return { status: "disabled" };
    } catch {
      return {
        status: "blocked",
        reason: "GitHub auto-merge cancellation could not be confirmed.",
      };
    }
  },
});
