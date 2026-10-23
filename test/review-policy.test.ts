import { assert, beforeEach, test, vi } from "vitest";
import type { ApprovalContext } from "eve/tools/approval";
import { approveReview } from "../agent/lib/review-policy.js";
import { mergeAssessment, mergePolicyVersion } from "../agent/lib/merge-assessment.js";
import githubMount from "../agent/extensions/github.js";
import { github } from "@github-tools/eve-extension/tools";

const target = { owner: "review-policy", repo: "app", pullNumber: 42 };

const ctx: ApprovalContext = {
  session: {
    id: "session",
    turn: { id: "turn", sequence: 1 },
    auth: {
      initiator: null,
      current: {
        authenticator: "github-webhook",
        principalId: "github:1",
        principalType: "user",
        attributes: {
          repository: "review-policy/app",
          conversation_kind: "pull_request",
          pull_request_number: "42",
        },
      },
    },
  },
  abortSignal: new AbortController().signal,
  toolInput: { ...target, event: "COMMENT", body: "review" },
  approvedTools: new Set(),
  toolName: "github__createPullRequestReview",
  callId: "call",
  getSandbox() {
    throw new Error("Unexpected sandbox access");
  },
};

const recorded = {
  policyVersion: mergePolicyVersion,
  turnId: "turn",
  target,
  status: "human_review_required",
  assessment: {
    headSha: "reviewed-head",
    coverage: "complete",
    unresolvedFindings: true,
    reversibility: "reversible",
    blastRadius: "localized",
    verification: "sufficient",
    reviewOnly: true,
    rationale: "A concrete blocking finding.",
  },
} satisfies NonNullable<ReturnType<typeof mergeAssessment.get>>;

beforeEach(() => {
  assert.ok(githubMount);
  vi.spyOn(mergeAssessment, "get").mockReturnValue(recorded);
});

const freshPr = {
  base: { ref: "main" },
  head: { sha: "reviewed-head" },
  state: "open",
  merged: false,
  draft: false,
};

function fixture(pr: Partial<typeof freshPr> = freshPr, status = 200) {
  const calls: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation((request, init) => {
    const url = new URL(request instanceof Request ? request.url : request.toString());
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);

    if (url.pathname === "/repos/review-policy/app/installation") {
      return Promise.resolve(Response.json({ id: 199 }));
    }

    if (url.pathname === "/app/installations/199/access_tokens") {
      return Promise.resolve(
        Response.json({
          token: "test-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: {},
          repository_selection: "all",
        }),
      );
    }

    if (url.pathname === "/repos/review-policy/app/pulls/42/reviews") {
      assert.strictEqual(init?.method, "POST");

      return Promise.resolve(Response.json({ id: 100, state: "COMMENTED" }));
    }

    assert.strictEqual(url.pathname, "/repos/review-policy/app/pulls/42");
    assert.strictEqual(init?.method ?? "GET", "GET");

    return Promise.resolve(
      Response.json(
        {
          ...freshPr,
          ...pr,
        },
        { status },
      ),
    );
  });

  return calls;
}

test("a review-only assessment with findings can publish on its current head", async () => {
  const calls = fixture();
  assert.strictEqual(await approveReview(ctx), "not-applicable");
  assert.include(calls, "GET /repos/review-policy/app/pulls/42");
});

test.each([
  { head: { sha: "new-head" }, state: "open", merged: false },
  { draft: true },
  { head: { sha: "reviewed-head" }, state: "closed", merged: false },
  { head: { sha: "reviewed-head" }, state: "closed", merged: true },
])("a stale or closed PR cannot publish the review", async (pr) => {
  fixture(pr);
  assert.deepInclude(await approveReview(ctx), { type: "denied" });
});

test.each([
  null,
  { ...recorded, turnId: "previous-turn" },
  { ...recorded, target: { ...target, pullNumber: 43 } },
  { ...recorded, policyVersion: 0 },
])("missing or stale assessments cannot publish", async (assessment) => {
  vi.spyOn(mergeAssessment, "get").mockReturnValue(assessment);
  const fetch = vi.spyOn(globalThis, "fetch");
  assert.deepInclude(await approveReview(ctx), { type: "denied" });
  assert.strictEqual(fetch.mock.calls.length, 0);
});

test("a request for a different PR is denied before network access", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  assert.deepInclude(await approveReview({ ...ctx, toolInput: { ...target, pullNumber: 43 } }), {
    type: "denied",
  });
  assert.strictEqual(fetch.mock.calls.length, 0);
});

test("a review with findings cannot publish a formal approval", async () => {
  const calls = fixture();
  assert.deepInclude(await approveReview({ ...ctx, toolInput: { ...target, event: "APPROVE" } }), {
    type: "denied",
  });
  assert.ok(calls.every((call) => !call.startsWith("POST /repos/")));
});

test("a failed readiness read denies publication", async () => {
  fixture({ head: { sha: "reviewed-head" }, state: "open", merged: false }, 404);
  assert.deepInclude(await approveReview(ctx), { type: "denied" });
});

test("unsigned and cancelled invocations cannot publish", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  assert.deepInclude(
    await approveReview({
      ...ctx,
      session: { ...ctx.session, auth: { current: null, initiator: null } },
    }),
    { type: "denied" },
  );
  assert.deepInclude(await approveReview({ ...ctx, abortSignal: AbortSignal.abort() }), {
    type: "denied",
  });
  assert.strictEqual(fetch.mock.calls.length, 0);
});

test.each(["reviewed-head", "new-head"])(
  "the mounted extension publishes only the assessed head (%s)",
  async (sha) => {
    const calls = fixture({ head: { sha } });

    const resolve = github.events["step.started"];
    assert.ok(resolve);

    const tools = await resolve(undefined, {
      model: null,
      session: ctx.session,
      channel: { kind: "github" },
      messages: [],
    });

    const tool = tools.createPullRequestReview;
    assert.ok(tool.approval);

    const policy = "request" in tool.approval ? tool.approval.request : tool.approval;
    const decision = await policy(ctx);

    if (decision === "not-applicable") {
      const output = await tool.execute(
        { ...target, event: "COMMENT", body: "review" },
        {
          ...ctx,
          messages: [],
          getToken() {
            throw new Error("Unexpected token access");
          },
          requireAuth() {
            throw new Error("Unexpected auth access");
          },
        },
      );

      assert.deepInclude(output, { id: 100 });
    }

    assert.strictEqual(
      calls.filter((call) => call === "POST /repos/review-policy/app/pulls/42/reviews").length,
      sha === "reviewed-head" ? 1 : 0,
    );
  },
);
