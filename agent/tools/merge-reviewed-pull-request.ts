import { createOctokit } from "@github-tools/sdk";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { githubToken } from "@/github";
import { mergeAssessment } from "@/merge-assessment";
import { approveMerge } from "@/merge-policy";

const mergeResponse = z.object({
  merged: z.boolean(),
  sha: z.string(),
  message: z.string(),
});

export default defineTool({
  description:
    "Squash merge the current PR after fresh readiness checks, atomically requiring its head to match the eligible assessment recorded this turn. A denied or failed attempt requires refreshing and reassessing; never fall back to an unpinned merge.",
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    pullNumber: z.number().int().positive(),
    mergeMethod: z.literal("squash"),
  }),
  async execute(input, ctx) {
    // Capture the same assessment that approveMerge reads before its first await.
    // The model cannot supply or replace the commit identity in the merge request.
    const recorded = mergeAssessment.get();

    const decision = await approveMerge({
      ...ctx,
      toolInput: input,
      approvedTools: new Set<string>(),
    });

    if (decision !== "not-applicable") {
      return decision;
    }

    if (!recorded) {
      throw new Error("The reviewed assessment is missing; refresh and reassess before merging.");
    }

    try {
      // SDK 1.18's merge tool omits `sha`, and its extension cannot override execution.
      // Its public Octokit client supplies the missing atomic precondition.
      const octokit = createOctokit(await githubToken({ toolName: ctx.toolName, ...input }));

      ctx.abortSignal.throwIfAborted();

      const { data } = await octokit.rest.pulls.merge({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullNumber,
        merge_method: "squash",
        sha: recorded.assessment.headSha,
        request: { signal: ctx.abortSignal, retries: 0 },
      });

      return mergeResponse.parse(data);
    } catch {
      ctx.abortSignal.throwIfAborted();
      throw new Error(
        "GitHub could not confirm the reviewed-head merge. Refresh the PR and reassess before retrying.",
      );
    }
  },
});
