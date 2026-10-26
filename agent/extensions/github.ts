import githubExtension from "@github-tools/eve-extension";
import { formatGithubEveToolOutput } from "@github-tools/sdk/eve-runtime";
import { z } from "zod";
import { githubToken } from "@/github";
import { approveReview } from "@/review-policy";

const postedComment = z.object({ id: z.number(), url: z.string() });

export default githubExtension({
  token: githubToken,
  preset: "code-review",
  include: [
    "createOrUpdateFile",
    "listIssueComments",
    "getIssue",
    "listLabels",
    "createLabel",
    "addLabels",
    "removeLabel",
  ],
  exclude: [
    "mergePullRequest",
    "createBranch",
    "createPullRequest",
    "deleteBranch",
    "resolveReviewThread",
  ],
  requireApproval: false,
  overrides: {
    createPullRequestReview: {
      approval: approveReview,
    },
    // A model repeated a successful call and posted the same summary twice, so
    // the result points every later summary change at the posted comment.
    addPullRequestComment: {
      description:
        "Create the bot's single timeline summary on a pull request. Call it at most once per PR; when a bot summary already exists, use updatePullRequestComment instead.",
      toModelOutput(output) {
        const comment = postedComment.safeParse(output);

        if (!comment.success) {
          return formatGithubEveToolOutput("addPullRequestComment", output);
        }

        const { id, url } = comment.data;

        return {
          type: "text",
          value: `Posted the PR summary as comment ${id} (${url}). Do not call addPullRequestComment again for this PR; change the summary with updatePullRequestComment using commentId ${id}.`,
        };
      },
    },
  },
});
