import githubExtension from "@github-tools/eve-extension";
import { githubToken } from "@/github";

export default githubExtension({
  token: githubToken,
  preset: "code-review",
  include: ["mergePullRequest"],
  requireApproval: false,
});
