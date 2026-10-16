import githubExtension from "@github-tools/eve-extension";
import { githubToken } from "@/github";

export default githubExtension({
  token: githubToken,
  preset: ["code-review", "pr-author"],
  include: ["mergePullRequest"],
  // Fixes commit to the PR head only; branch and PR creation stay unavailable.
  exclude: ["createBranch", "deleteBranch", "createPullRequest"],
  requireApproval: false,
});
