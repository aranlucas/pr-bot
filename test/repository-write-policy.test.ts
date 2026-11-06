import { assert, test } from "vitest";
import type { ApprovalContext } from "eve/tools/approval";
import githubExtension from "@github-tools/eve-extension";
import githubMount from "../agent/extensions/github.js";

const writes = [
  "createOrUpdateFile",
  "addLabels",
  "removeLabel",
  "createLabel",
  "updatePullRequest",
  "addPullRequestComment",
  "updatePullRequestComment",
  "deletePullRequestComment",
  "replyToReviewComment",
  "requestReviewers",
] as const;

const mounted = githubMount as ReturnType<typeof githubExtension>;
const tools = mounted.tools;

for (const tool of writes) {
  test.each([
    { signed: "Acme/App", owner: "acme", repo: "app", allowed: true },
    { signed: "Acme/App", owner: "acme", repo: "other", allowed: false },
    { signed: "Acme/App", owner: "other", repo: "app", allowed: false },
    { signed: null, owner: "acme", repo: "app", allowed: false },
  ])(
    `${tool} confines writes to the signed repository: %j`,
    async ({ signed, owner, repo, allowed }) => {
      const policy = tools[tool].approval;
      assert.isFunction(policy);
      if (typeof policy !== "function") throw new Error("Missing repository write gate");
      const ctx = {
        session: {
          auth: {
            current: signed
              ? { authenticator: "github-webhook", attributes: { repository: signed } }
              : null,
          },
        },
        toolInput: { owner, repo },
      } as ApprovalContext;
      const result = await policy(ctx);
      if (allowed) assert.strictEqual(result, "not-applicable");
      else assert.deepInclude(result, { type: "denied" });
    },
  );
}
