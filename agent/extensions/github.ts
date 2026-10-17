import githubExtension from "@github-tools/eve-extension";
import { githubToken } from "@/github";

export default githubExtension({
  token: githubToken,
  preset: ["code-review", "pr-author"],
  include: [
    "mergePullRequest",
    "listIssueComments",
    "getIssue",
    "listLabels",
    "createLabel",
    "addLabels",
    "removeLabel",
  ],
  exclude: ["deleteBranch", "resolveReviewThread"],
  requireApproval: false,
});
