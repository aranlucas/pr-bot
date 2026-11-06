import { assert, test } from "vitest";
import type { ApprovalContext } from "eve/tools/approval";
import { github } from "@github-tools/eve-extension/tools";
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

function unexpected(): never {
  throw new Error("Unexpected fixture operation");
}

for (const tool of writes) {
  test.each([
    { signed: "Acme/App", owner: "acme", repo: "app", allowed: true },
    { signed: "Acme/App", owner: "acme", repo: "other", allowed: false },
    { signed: "Acme/App", owner: "other", repo: "app", allowed: false },
    { signed: null, owner: "acme", repo: "app", allowed: false },
  ])(
    `${tool} confines writes to the signed repository: %j`,
    async ({ signed, owner, repo, allowed }) => {
      assert.ok(githubMount);

      const ctx: ApprovalContext = {
        session: {
          id: "session",
          turn: { id: "turn", sequence: 1 },
          auth: {
            initiator: null,
            current: signed
              ? {
                  authenticator: "github-webhook",
                  principalId: "github:10",
                  principalType: "user",
                  attributes: { repository: signed },
                }
              : null,
          },
        },
        toolInput: { owner, repo },
        approvedTools: new Set<string>(),
        getSandbox: unexpected,
        abortSignal: new AbortController().signal,
        callId: "call",
        toolName: `github__${tool}`,
      };

      const resolve = github.events["step.started"];
      assert.ok(resolve);

      const tools = await resolve(undefined, {
        model: null,
        session: ctx.session,
        channel: { kind: "github" },
        messages: [],
      });

      const approval = tools[tool].approval;
      assert.ok(approval);
      const policy = "request" in approval ? approval.request : approval;
      const result = await policy(ctx);

      if (allowed) {
        assert.strictEqual(result, "not-applicable");
      } else {
        assert.deepInclude(result, { type: "denied" });
      }
    },
  );
}
