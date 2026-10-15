import { defineTool } from "eve/tools";
import { z } from "zod";
import { githubToken } from "@/github";

const mergeResponse = z.object({
  merged: z.boolean(),
  sha: z.string(),
  message: z.string(),
});

export default defineTool({
  description:
    "Squash merge a pull request only if its current head matches the full SHA reviewed and named in the published review comment. A merge conflict requires refreshed review before another attempt.",
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    pullNumber: z.number().int().positive(),
    reviewedHeadSha: z.string().regex(/^[a-fA-F0-9]{40}$/),
  }),
  async execute(input, ctx) {
    const token = await githubToken();

    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.pullNumber}/merge`,
      {
        method: "PUT",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        body: JSON.stringify({ sha: input.reviewedHeadSha, merge_method: "squash" }),
        signal: ctx.abortSignal,
        redirect: "error",
      },
    );

    if (response.status === 409) {
      throw new Error(
        "Merge conflict. Refresh the pull request and review its current head before trying again.",
      );
    }

    if (!response.ok) {
      throw new Error(`GitHub merge failed (HTTP ${response.status})`);
    }

    return mergeResponse.parse(await response.json());
  },
});
