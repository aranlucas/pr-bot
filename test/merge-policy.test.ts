import { assert, beforeEach, expect, test, vi } from "vitest";
import { github } from "@github-tools/eve-extension/tools";
import type { ToolContext } from "eve/tools";
import type { ApprovalContext } from "eve/tools/approval";
import { z } from "zod";
import githubMount from "../agent/extensions/github.js";
import type { assessmentInput } from "../agent/lib/merge-assessment.js";
import { mergeAssessment } from "../agent/lib/merge-assessment.js";
import recordAssessment from "../agent/tools/record-merge-assessment.js";
import enableAutoMerge from "../agent/tools/enable-auto-merge.js";
import disableAutoMerge from "../agent/tools/disable-auto-merge.js";

const sha = "a".repeat(40);

const target = { owner: "policy", repo: "app", pullNumber: 42 };

const input = { ...target, mergeMethod: "squash" };

const assessment = {
  headSha: sha,
  coverage: "complete",
  unresolvedFindings: false,
  reversibility: "reversible",
  blastRadius: "localized",
  verification: "sufficient",
  reviewOnly: false,
  rationale: "Documentation correction with no runtime effects; all changed files reviewed.",
} satisfies z.infer<typeof assessmentInput>;

function unexpected(): never {
  throw new Error("Unexpected fixture operation");
}

const ctx: ToolContext = {
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
          repository: "policy/app",
          conversation_kind: "pull_request",
          pull_request_number: "42",
          installation_id: "99",
        },
      },
    },
  },
  getSandbox: unexpected,
  getToken: unexpected,
  requireAuth: unexpected,
  abortSignal: new AbortController().signal,
  callId: "call",
  toolName: "record-merge-assessment",
  messages: [],
};

let stored: ReturnType<typeof mergeAssessment.get>;

const fixturePr = z.object({
  number: z.number(),
  state: z.string(),
  merged: z.boolean(),
  draft: z.boolean(),
  mergeable: z.boolean().nullable(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
});

const fixtureData = z.object({
  pr: fixturePr,
  finalPr: fixturePr,
  labels: z.array(z.string()),
  reviews: z.array(
    z.object({ id: z.number(), state: z.string(), user: z.object({ login: z.string() }) }),
  ),
  checkRuns: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
    }),
  ),
  checkTotal: z.number(),
  statuses: z.array(z.object({ context: z.string(), state: z.string() })),
  statusTotal: z.number(),
  statusState: z.string(),
  commits: z.array(
    z.object({
      sha: z.string(),
      commit: z.object({ author: z.object({ name: z.string() }) }),
      author: z.object({ login: z.string() }),
    }),
  ),
  commitTotal: z.number(),
  failPath: z.string(),
});

beforeEach(() => {
  stored = null;
  // The durable state boundary is supplied by Eve in production.
  vi.spyOn(mergeAssessment, "get").mockImplementation(() => stored);
  vi.spyOn(mergeAssessment, "update").mockImplementation((update) => {
    stored = update(stored);
  });
});

async function fixture() {
  const calls: string[] = [];

  const pr = {
    number: 42,
    state: "open",
    merged: false,
    draft: false,
    mergeable: true,
    head: { ref: "feature", sha },
    base: { ref: "main" },
  };

  const data = fixtureData.parse({
    pr,
    finalPr: pr,
    labels: [],
    reviews: [],
    checkRuns: [{ id: 1, name: "test", status: "completed", conclusion: "success" }],
    checkTotal: 1,
    statuses: [],
    statusTotal: 0,
    statusState: "pending",
    commits: [{ sha, commit: { author: { name: "Developer" } }, author: { login: "developer" } }],
    commitTotal: 1,
    failPath: "",
  });

  const queuedPr = {
    id: "PR_42",
    headRefOid: sha,
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "BLOCKED",
    reviews: { nodes: [{ state: "APPROVED", commit: { oid: sha } }] },
    baseRef: {
      branchProtectionRule: {
        requiresApprovingReviews: true,
        dismissesStaleReviews: true,
        requiredApprovingReviewCount: 1,
      },
    },
  };

  const queueState = { repository: { autoMergeAllowed: true, pullRequest: queuedPr } };

  const cancellation = z
    .object({
      autoMergeRequest: z.object({ enabledAt: z.string() }).nullable(),
    })
    .parse({ autoMergeRequest: { enabledAt: "2026-10-23T00:00:00Z" } });

  const mutations: unknown[] = [];
  let queueError = false;
  let mergeOnEnable = false;
  let reads = 0;

  vi.spyOn(globalThis, "fetch").mockImplementation((request, init) => {
    const url = new URL(request instanceof Request ? request.url : request.toString());
    const path = url.pathname;
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    const authorization = new Headers(init?.headers).get("authorization");

    if (path === "/repos/policy/app/installation") {
      assert.ok(authorization?.startsWith("bearer ey"));

      return Promise.resolve(Response.json({ id: 99 }));
    }

    if (path === "/app/installations/99/access_tokens") {
      assert.ok(authorization?.startsWith("bearer ey"));

      return Promise.resolve(
        Response.json({
          token: "policy-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: {},
          repository_selection: "all",
        }),
      );
    }

    assert.strictEqual(authorization, "token policy-token");

    if (path === data.failPath) {
      return Promise.resolve(Response.json({ message: "Not Found" }, { status: 404 }));
    }

    if (path === "/repos/policy/app/pulls/42") {
      reads += 1;

      return Promise.resolve(Response.json(reads === 1 ? data.pr : data.finalPr));
    }

    if (path === "/repos/policy/app/issues/42") {
      return Promise.resolve(Response.json({ labels: data.labels }));
    }

    if (path === "/repos/policy/app/pulls/42/reviews" && method === "POST") {
      assert.strictEqual(
        z.object({ event: z.string() }).parse(JSON.parse(z.string().parse(init?.body))).event,
        "APPROVE",
      );

      return Promise.resolve(Response.json({ id: 100, state: "APPROVED" }));
    }

    if (path === "/graphql") {
      const body = z
        .object({ query: z.string(), variables: z.object({ input: z.unknown().optional() }) })
        .parse(JSON.parse(z.string().parse(init?.body)));

      if (body.query.includes("mutation EnableAutoMerge")) {
        mutations.push(body.variables.input);

        return Promise.resolve(
          Response.json(
            queueError
              ? { errors: [{ message: "Head changed", type: "UNPROCESSABLE" }] }
              : {
                  data: {
                    enablePullRequestAutoMerge: {
                      pullRequest: {
                        merged: mergeOnEnable,
                        autoMergeRequest: mergeOnEnable ? null : { mergeMethod: "SQUASH" },
                      },
                    },
                  },
                },
          ),
        );
      }

      if (body.query.includes("query AutoMergeCancellation")) {
        return Promise.resolve(
          Response.json({
            data: { repository: { pullRequest: { id: "PR_42", ...cancellation } } },
          }),
        );
      }

      if (body.query.includes("mutation DisableAutoMerge")) {
        mutations.push(body.variables.input);

        return Promise.resolve(
          Response.json(
            queueError
              ? { errors: [{ message: "Cancellation failed", type: "UNPROCESSABLE" }] }
              : {
                  data: {
                    disablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: null } },
                  },
                },
          ),
        );
      }

      assert.include(body.query, "query AutoMergeReadiness");

      return Promise.resolve(Response.json({ data: queueState }));
    }

    if (path === "/repos/policy/app/pulls/42/reviews") {
      return Promise.resolve(Response.json(data.reviews));
    }

    if (path.startsWith("/repos/policy/app/commits/") && path.endsWith("/check-runs")) {
      return Promise.resolve(
        Response.json({ total_count: data.checkTotal, check_runs: data.checkRuns }),
      );
    }

    if (path.startsWith("/repos/policy/app/commits/") && path.endsWith("/status")) {
      return Promise.resolve(
        Response.json({
          state: data.statusState,
          total_count: data.statusTotal,
          statuses: data.statuses,
        }),
      );
    }

    if (path === `/repos/policy/app/compare/main...${sha}`) {
      return Promise.resolve(
        Response.json({ total_commits: data.commitTotal, commits: data.commits }),
      );
    }

    if (path === "/repos/policy/app/pulls/42/merge") {
      assert.strictEqual(method, "PUT");
      assert.strictEqual(
        z.object({ merge_method: z.string() }).parse(JSON.parse(z.string().parse(init?.body)))
          .merge_method,
        "squash",
      );

      return Promise.resolve(Response.json({ merged: true, sha: "merged" }));
    }

    throw new Error(`Unexpected request: ${method} ${url}`);
  });

  const resolve = github.events["step.started"];
  assert.ok(resolve);

  const tools = await resolve(undefined, {
    model: null,
    session: ctx.session,
    channel: { kind: "github" },
    messages: [],
  });

  const tool = tools.mergePullRequest;
  assert.ok(tool?.approval);
  assert.ok(githubMount);
  const policy = "request" in tool.approval ? tool.approval.request : tool.approval;

  return {
    data,
    calls,
    queueState,
    cancellation,
    mutations,
    cancel() {
      return disableAutoMerge.execute({}, { ...ctx, toolName: "disable-auto-merge" });
    },
    completeQueueImmediately() {
      mergeOnEnable = true;
    },
    failQueue() {
      queueError = true;
    },
    queue() {
      return enableAutoMerge.execute({}, { ...ctx, toolName: "enable-auto-merge" });
    },
    async approve() {
      const reviewTool = tools.createPullRequestReview;
      assert.ok(reviewTool?.approval);

      const reviewPolicy =
        "request" in reviewTool.approval ? reviewTool.approval.request : reviewTool.approval;

      const reviewInput = { ...target, event: "APPROVE", body: "No concrete defects found." };

      const result = await reviewPolicy({
        ...ctx,
        toolName: "github__createPullRequestReview",
        toolInput: reviewInput,
        approvedTools: new Set(),
      });

      if (result === "not-applicable") {
        await reviewTool.execute(reviewInput, {
          ...ctx,
          toolName: "github__createPullRequestReview",
        });
      }

      return result;
    },
    async merge(overrides: Partial<ApprovalContext> = {}) {
      const status = await policy({
        ...ctx,
        approvedTools: new Set(),
        toolInput: input,
        toolName: "github__mergePullRequest",
        ...overrides,
      });

      if (status === "not-applicable") {
        await tool.execute(input, { ...ctx, toolName: "github__mergePullRequest" });
      }

      return status;
    },
  };
}

test("a recorded, complete review allows the native squash merge after fresh GitHub checks", async () => {
  const f = await fixture();

  const result = z
    .object({ status: z.string(), reasons: z.array(z.string()) })
    .parse(await recordAssessment.execute({ ...assessment }, ctx));

  assert.strictEqual(result.status, "eligible");
  assert.deepEqual(result.reasons, []);
  assert.strictEqual(await f.merge(), "not-applicable");
  assert.strictEqual(f.calls.at(-1), "PUT /repos/policy/app/pulls/42/merge");
  assert.strictEqual(f.calls.filter((call) => call === "GET /repos/policy/app/pulls/42").length, 2);
});

test.each([
  {
    change: { unresolvedFindings: true },
    status: "human_review_required",
    reason: "unresolved_findings",
  },
  { change: { reviewOnly: true }, status: "human_review_required", reason: "review_only" },
  {
    change: { reversibility: "irreversible" },
    status: "human_review_required",
    reason: "irreversible",
  },
  { change: { reversibility: "uncertain" }, status: "human_review_required", reason: "uncertain" },
  {
    change: { blastRadius: "broad" },
    status: "human_review_required",
    reason: "blast_radius_broad",
  },
  {
    change: { blastRadius: "uncertain" },
    status: "human_review_required",
    reason: "blast_radius_uncertain",
  },
  {
    change: { coverage: "incomplete" },
    status: "waiting_for_evidence",
    reason: "incomplete_coverage",
  },
  {
    change: { verification: "missing" },
    status: "waiting_for_evidence",
    reason: "missing_verification",
  },
] as const)("$reason prevents automatic merging", async ({ change, status, reason }) => {
  const f = await fixture();

  const result = z
    .object({ status: z.string(), reasons: z.array(z.string()) })
    .parse(await recordAssessment.execute({ ...assessment, ...change }, ctx));

  assert.strictEqual(result.status, status);
  assert.include(result.reasons, reason);
  assert.deepInclude(await f.merge(), { type: "denied" });
  assert.deepEqual(f.calls, []);
});

test.each([
  "absent",
  "previous turn",
  "previous policy",
  "different PR",
  "different repository",
  "different strategy",
  "unsigned",
])("rejects an assessment from $0", async (condition) => {
  const f = await fixture();
  await recordAssessment.execute({ ...assessment }, ctx);
  assert.ok(stored);

  if (condition === "previous turn") {
    stored.turnId = "old-turn";
  }

  if (condition === "previous policy") {
    stored.policyVersion = 0;
  }

  if (condition === "absent") {
    stored = null;
  }

  let overrides: Partial<ApprovalContext> = {};

  if (condition === "different PR") {
    overrides = { toolInput: { ...input, pullNumber: 43 } };
  }

  if (condition === "different repository") {
    overrides = { toolInput: { ...input, repo: "other" } };
  }

  if (condition === "different strategy") {
    overrides = { toolInput: { ...input, mergeMethod: "merge" } };
  }

  if (condition === "unsigned") {
    overrides = { session: { ...ctx.session, auth: { current: null, initiator: null } } };
  }

  assert.deepInclude(await f.merge(overrides), { type: "denied" });
  assert.deepEqual(f.calls, []);
});

test.each([
  { condition: "head changed", reason: "the head changed" },
  { condition: "closed", reason: "closed, merged, draft" },
  { condition: "merged", reason: "closed, merged, draft" },
  { condition: "draft", reason: "closed, merged, draft" },
  { condition: "conflicting", reason: "mergeability is unknown" },
  { condition: "unknown mergeability", reason: "mergeability is unknown" },
  { condition: "paused", reason: "merging is paused" },
  { condition: "changes requested", reason: "review requests changes" },
  { condition: "incomplete reviews", reason: "review history is incomplete" },
  { condition: "pending checks", reason: "CI is pending or unsuccessful" },
  { condition: "failed checks", reason: "CI is pending or unsuccessful" },
  { condition: "incomplete checks", reason: "CI evidence is incomplete" },
  { condition: "failed status", reason: "CI is pending or unsuccessful" },
  { condition: "incomplete statuses", reason: "CI evidence is incomplete" },
  { condition: "own commit name", reason: "contains the bot's commits" },
  { condition: "own commit login", reason: "contains the bot's commits" },
  { condition: "missing commits", reason: "commit authorship evidence is incomplete" },
  { condition: "unknown author", reason: "commit authorship evidence is incomplete" },
  { condition: "read failure", reason: "GitHub readiness could not be verified" },
  { condition: "changed during checks", reason: "changed during readiness checks" },
])("fresh evidence blocks merging: $condition", async ({ condition, reason }) => {
  const f = await fixture();
  await recordAssessment.execute({ ...assessment }, ctx);

  if (condition === "head changed") {
    assert.ok(stored);
    stored.assessment.headSha = "b".repeat(40);
  }

  if (condition === "closed") {
    f.data.pr.state = "closed";
  }

  if (condition === "merged") {
    f.data.pr.merged = true;
  }

  if (condition === "draft") {
    f.data.pr.draft = true;
  }

  if (condition === "conflicting") {
    f.data.pr.mergeable = false;
  }

  if (condition === "unknown mergeability") {
    f.data.pr.mergeable = null;
  }

  if (condition === "paused") {
    f.data.labels = ["PR-Bot:Paused"];
  }

  if (condition === "changes requested") {
    f.data.reviews = [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "reviewer" } }];
  }

  if (condition === "incomplete reviews") {
    f.data.reviews = Array.from({ length: 30 }, (_, id) => ({
      id,
      state: "COMMENTED",
      user: { login: "reviewer" },
    }));
  }

  if (condition === "pending checks") {
    f.data.checkRuns[0].status = "in_progress";
  }

  if (condition === "failed checks") {
    f.data.checkRuns[0].conclusion = "failure";
  }

  if (condition === "incomplete checks") {
    f.data.checkTotal = 2;
  }

  if (condition === "failed status") {
    f.data.statusTotal = 1;
    f.data.statusState = "failure";
    f.data.statuses = [{ context: "ci", state: "failure" }];
  }

  if (condition === "incomplete statuses") {
    f.data.statusTotal = 1;
  }

  if (condition === "own commit name") {
    f.data.commits[0].commit.author.name = "aranlucas-pr-bot[bot]";
  }

  if (condition === "own commit login") {
    f.data.commits[0].author.login = "aranlucas-pr-bot[bot]";
  }

  if (condition === "missing commits") {
    f.data.commitTotal = 2;
  }

  if (condition === "unknown author") {
    f.data.commits[0].author.login = "";
    f.data.commits[0].commit.author.name = "";
  }

  if (condition === "read failure") {
    f.data.failPath = "/repos/policy/app/issues/42";
  }

  if (condition === "changed during checks") {
    f.data.finalPr = { ...f.data.pr, head: { ref: "feature", sha: "b".repeat(40) } };
  }

  const status = await f.merge();
  assert.deepInclude(status, { type: "denied" });
  assert.include(z.object({ reason: z.string() }).parse(status).reason, reason);
  assert.ok(f.calls.every((call) => !call.startsWith("PUT ")));
});

test.each(["neutral", "skipped", "no CI"])(
  "permits %s without treating an absent legacy status as pending CI",
  async (signals) => {
    const f = await fixture();
    await recordAssessment.execute({ ...assessment }, ctx);

    if (signals === "no CI") {
      f.data.checkRuns = [];
      f.data.checkTotal = 0;
    } else {
      f.data.checkRuns[0].conclusion = signals;
    }

    assert.strictEqual(await f.merge(), "not-applicable");
  },
);

test("an unsigned invocation cannot record an assessment", async () => {
  await expect(
    Promise.resolve().then(() =>
      recordAssessment.execute(
        { ...assessment },
        {
          ...ctx,
          session: { ...ctx.session, auth: { current: null, initiator: null } },
        },
      ),
    ),
  ).rejects.toThrow("signed GitHub pull-request invocation is required");
  assert.isNull(stored);
});

test("a later approval clears a change request; a comment alone does not", async () => {
  const f = await fixture();
  await recordAssessment.execute({ ...assessment }, ctx);
  f.data.reviews = [
    { id: 1, state: "CHANGES_REQUESTED", user: { login: "reviewer" } },
    { id: 2, state: "COMMENTED", user: { login: "reviewer" } },
  ];
  assert.deepInclude(await f.merge(), { type: "denied" });
  f.data.reviews.push({ id: 3, state: "APPROVED", user: { login: "reviewer" } });
  assert.strictEqual(await f.merge(), "not-applicable");
});

test("a clean review approves and queues the assessed head while required checks are pending", async () => {
  const f = await fixture();
  await recordAssessment.execute({ ...assessment }, ctx);
  f.data.checkRuns[0].status = "in_progress";
  f.data.checkRuns[0].conclusion = null;
  f.data.statuses = [{ context: "build", state: "pending" }];
  f.data.statusTotal = 1;
  assert.strictEqual(await f.approve(), "not-applicable");
  assert.include(f.calls, "POST /repos/policy/app/pulls/42/reviews");
  assert.deepInclude(await f.merge(), { type: "denied" });
  assert.deepInclude(await f.queue(), { status: "queued" });
  assert.deepEqual(f.mutations, [
    { pullRequestId: "PR_42", expectedHeadOid: sha, mergeMethod: "SQUASH" },
  ]);
});

test.each([
  "draft",
  "paused",
  "own commit",
  "changes requested",
  "failed CI",
  "incomplete CI",
  "head changed",
  "review only",
])("approval and queueing preserve the existing guard: %s", async (condition) => {
  const f = await fixture();
  await recordAssessment.execute({ ...assessment, reviewOnly: condition === "review only" }, ctx);

  if (condition === "draft") {
    f.data.pr.draft = true;
    f.data.finalPr.draft = true;
  }

  if (condition === "paused") {
    f.data.labels = ["pr-bot:paused"];
  }

  if (condition === "own commit") {
    f.data.commits[0].author.login = "aranlucas-pr-bot[bot]";
  }

  if (condition === "changes requested") {
    f.data.reviews = [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "reviewer" } }];
  }

  if (condition === "failed CI") {
    f.data.checkRuns[0].conclusion = "failure";
  }

  if (condition === "incomplete CI") {
    f.data.checkTotal = 2;
  }

  if (condition === "head changed") {
    f.data.pr.head.sha = "new-head";
    f.data.finalPr.head.sha = "new-head";
  }

  assert.deepInclude(await f.approve(), { type: "denied" });
  assert.deepInclude(await f.queue(), { status: "blocked" });
  assert.deepEqual(f.mutations, []);
  assert.ok(f.calls.every((call) => call !== "POST /repos/policy/app/pulls/42/reviews"));
});

test.each([
  "disabled",
  "stale approvals retained",
  "no required reviews",
  "unknown mergeability",
  "draft",
  "new head",
  "mutation fails",
])("queueing fails closed when %s", async (condition) => {
  const f = await fixture();
  await recordAssessment.execute({ ...assessment }, ctx);
  const pr = f.queueState.repository.pullRequest;

  if (condition === "disabled") {
    f.queueState.repository.autoMergeAllowed = false;
  }

  if (condition === "stale approvals retained") {
    pr.baseRef.branchProtectionRule.dismissesStaleReviews = false;
  }

  if (condition === "no required reviews") {
    pr.baseRef.branchProtectionRule.requiredApprovingReviewCount = 0;
  }

  if (condition === "unknown mergeability") {
    pr.mergeStateStatus = "UNKNOWN";
  }

  if (condition === "draft") {
    pr.isDraft = true;
  }

  if (condition === "new head") {
    pr.headRefOid = "new-head";
  }

  if (condition === "mutation fails") {
    f.failQueue();
  }

  assert.deepInclude(await f.queue(), { status: "blocked" });
  assert.lengthOf(f.mutations, condition === "mutation fails" ? 1 : 0);
});

test("a ready approved head uses the native merge path without enabling auto-merge", async () => {
  const f = await fixture();
  await recordAssessment.execute({ ...assessment }, ctx);
  f.queueState.repository.pullRequest.mergeStateStatus = "CLEAN";
  assert.deepInclude(await f.queue(), { status: "ready" });
  assert.deepEqual(f.mutations, []);
  assert.strictEqual(await f.merge(), "not-applicable");
  assert.strictEqual(f.calls.at(-1), "PUT /repos/policy/app/pulls/42/merge");
});

test("queueing requires a published approval at the assessed head", async () => {
  const f = await fixture();
  await recordAssessment.execute({ ...assessment }, ctx);
  f.queueState.repository.pullRequest.reviews.nodes[0].commit.oid = "older-head";
  assert.deepInclude(await f.queue(), { status: "blocked" });
  assert.deepEqual(f.mutations, []);
});

test.each([true, false])(
  "pausing cancels an existing queue idempotently (queued=%s)",
  async (queued) => {
    const f = await fixture();

    if (!queued) {
      f.cancellation.autoMergeRequest = null;
    }

    assert.deepInclude(await f.cancel(), { status: "disabled" });
    assert.deepEqual(f.mutations, queued ? [{ pullRequestId: "PR_42" }] : []);
  },
);

test("failed cancellation cannot report success", async () => {
  const f = await fixture();
  f.failQueue();
  assert.deepInclude(await f.cancel(), { status: "blocked" });
});

test.each([enableAutoMerge, disableAutoMerge])(
  "unsigned auto-merge calls cannot access GitHub",
  async (tool) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    assert.deepInclude(
      await tool.execute(
        {},
        { ...ctx, session: { ...ctx.session, auth: { current: null, initiator: null } } },
      ),
      { status: "blocked" },
    );
    assert.lengthOf(fetch.mock.calls, 0);
  },
);

test("a queue request that GitHub merges immediately is reported as merged", async () => {
  const f = await fixture();
  await recordAssessment.execute({ ...assessment }, ctx);
  f.completeQueueImmediately();
  assert.deepInclude(await f.queue(), { status: "merged" });
});
