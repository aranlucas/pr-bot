import { assert, beforeEach, expect, test, vi } from "vitest";
import type { github as GithubTools } from "@github-tools/eve-extension/tools";
import type { ToolContext } from "eve/tools";
import type { ApprovalContext } from "eve/tools/approval";
import { z } from "zod";
import type GithubMount from "../agent/extensions/github.js";
import type {
  assessmentInput,
  mergeAssessment as MergeAssessment,
} from "../agent/lib/merge-assessment.js";
import type RecordAssessment from "../agent/tools/record-merge-assessment.js";
import type EnableAutoMerge from "../agent/tools/enable-auto-merge.js";
import type DisableAutoMerge from "../agent/tools/disable-auto-merge.js";
import type MergeReviewedPullRequest from "../agent/tools/merge-reviewed-pull-request.js";
import type { approveMerge as ApproveMerge } from "../agent/lib/merge-policy.js";

let github: typeof GithubTools;

let githubMount: typeof GithubMount;

let mergeAssessment: typeof MergeAssessment;

let recordAssessment: typeof RecordAssessment;

let enableAutoMerge: typeof EnableAutoMerge;

let disableAutoMerge: typeof DisableAutoMerge;

let mergeReviewedPullRequest: typeof MergeReviewedPullRequest;

let approveMerge: typeof ApproveMerge;

const sha = "a".repeat(40);

const target = { owner: "policy", repo: "app", pullNumber: 42 };

const input = { ...target, mergeMethod: "squash" as const };

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
  appSlug: z.string().default("patchling-pr"),
});

beforeEach(async () => {
  vi.resetModules();
  mergeReviewedPullRequest = (await import("../agent/tools/merge-reviewed-pull-request.js"))
    .default;
  approveMerge = (await import("../agent/lib/merge-policy.js")).approveMerge;
  github = (await import("@github-tools/eve-extension/tools")).github;
  githubMount = (await import("../agent/extensions/github.js")).default;
  mergeAssessment = (await import("../agent/lib/merge-assessment.js")).mergeAssessment;
  recordAssessment = (await import("../agent/tools/record-merge-assessment.js")).default;
  enableAutoMerge = (await import("../agent/tools/enable-auto-merge.js")).default;
  disableAutoMerge = (await import("../agent/tools/disable-auto-merge.js")).default;
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
  let mergeHead = sha;
  let mergeReply: Response | Error | null = null;
  const mergeBodies: unknown[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation((request, init) => {
    const url = new URL(request instanceof Request ? request.url : request.toString());
    const path = url.pathname;
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    const authorization = new Headers(init?.headers).get("authorization");

    if (path === "/app") {
      assert.ok(authorization?.startsWith("bearer ey"));

      return Promise.resolve(
        path === data.failPath
          ? Response.json({ message: "Not found" }, { status: 404 })
          : Response.json({ id: 5335315, slug: data.appSlug }),
      );
    }

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
        .object({
          query: z.string(),
          variables: z.object({ input: z.unknown().optional(), botLogin: z.string().optional() }),
        })
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
      assert.strictEqual(body.variables.botLogin, "patchling-pr[bot]");

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
      const body: unknown = JSON.parse(z.string().parse(init?.body));
      mergeBodies.push(body);
      assert.deepEqual(body, { sha, merge_method: "squash" });
      assert.strictEqual(init?.signal, ctx.abortSignal);

      if (mergeHead !== sha) {
        return Promise.resolve(Response.json({ message: "Head changed" }, { status: 409 }));
      }

      if (mergeReply instanceof Error) {
        return Promise.reject(mergeReply);
      }

      return Promise.resolve(
        mergeReply ?? Response.json({ merged: true, sha: "merged", message: "Merged" }),
      );
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

  assert.isUndefined(tools.mergePullRequest);
  assert.ok(githubMount);

  return {
    data,
    calls,
    queueState,
    cancellation,
    mutations,
    mergeBodies,
    pushBeforeMerge() {
      mergeHead = "b".repeat(40);
    },
    replyToMerge(reply: Response | Error) {
      mergeReply = reply;
    },
    mergeResult() {
      return mergeReviewedPullRequest.execute(input, {
        ...ctx,
        toolName: "merge-reviewed-pull-request",
      });
    },
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
      // Keep the malformed tool-input cases at the shared policy's untyped boundary.
      if (overrides.toolInput !== undefined) {
        return approveMerge({ ...ctx, approvedTools: new Set(), toolInput: input, ...overrides });
      }

      const result = await mergeReviewedPullRequest.execute(input, {
        ...ctx,
        ...overrides,
        toolName: "merge-reviewed-pull-request",
      });

      return "type" in result ? result : "not-applicable";
    },
  };
}

test("a recorded, complete review allows the reviewed-head squash merge after fresh GitHub checks", async () => {
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
    f.data.commits[0].commit.author.name = "patchling-pr[bot]";
  }

  if (condition === "own commit login") {
    f.data.commits[0].author.login = "patchling-pr[bot]";
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

  const result = z
    .object({ status: z.literal("queued"), mergeMethod: z.literal("SQUASH") })
    .parse(await f.queue());

  const endsTurn = enableAutoMerge.endsTurn;
  assert.ok(endsTurn && endsTurn !== true);
  assert.isFalse(await endsTurn(result));
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
    f.data.commits[0].author.login = "patchling-pr[bot]";
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

test("a ready approved head uses the reviewed-head merge path without enabling auto-merge", async () => {
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

test.each(["unavailable", "malformed"])(
  "an %s App identity blocks approval, merging, and queueing, then recovers safely",
  async (condition) => {
    const f = await fixture();
    await recordAssessment.execute({ ...assessment }, ctx);
    f.data.failPath = condition === "unavailable" ? "/app" : "";
    f.data.appSlug = condition === "malformed" ? "" : "patchling-pr";

    assert.deepInclude(await f.approve(), { type: "denied" });
    assert.deepInclude(await f.merge(), { type: "denied" });
    assert.deepInclude(await f.queue(), { status: "blocked" });
    assert.deepEqual(f.mutations, []);
    assert.ok(f.calls.every((call) => !/^(POST|PUT) \/repos\//u.test(call)));

    f.data.failPath = "";
    f.data.appSlug = "patchling-pr";
    f.data.commits[0].author.login = "PATCHLING-PR[bot]";

    const denied = z
      .object({ type: z.literal("denied"), reason: z.string() })
      .parse(await f.merge());

    assert.include(denied.reason, "contains the bot's commits");
    assert.deepInclude(await f.queue(), { status: "blocked" });
    assert.deepEqual(f.mutations, []);
  },
);

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

test.each(["enable", "disable"])(
  "unsigned %s auto-merge calls cannot access GitHub",
  async (operation) => {
    const tool = operation === "enable" ? enableAutoMerge : disableAutoMerge;
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

  const result = z.object({ status: z.literal("merged") }).parse(await f.queue());
  const endsTurn = enableAutoMerge.endsTurn;
  assert.ok(endsTurn && endsTurn !== true);
  assert.isTrue(await endsTurn(result));
});

test("a push after the final readiness read prevents a merge without an unpinned retry", async () => {
  const f = await fixture();
  await recordAssessment.execute({ ...assessment }, ctx);
  f.pushBeforeMerge();

  await expect(f.mergeResult()).rejects.toThrow("Refresh the PR and reassess");
  assert.deepEqual(f.mergeBodies, [{ sha, merge_method: "squash" }]);
  assert.strictEqual(f.calls.filter((call) => call === "GET /repos/policy/app/pulls/42").length, 2);
});

test.each([403, 405, 422, 500])(
  "a failed merge with HTTP %i does not leak its body or retry",
  async (status) => {
    const f = await fixture();
    await recordAssessment.execute({ ...assessment }, ctx);
    f.replyToMerge(Response.json({ message: "private repository response" }, { status }));

    await expect(f.mergeResult()).rejects.toThrow(
      "GitHub could not confirm the reviewed-head merge. Refresh the PR and reassess before retrying.",
    );
    assert.lengthOf(f.mergeBodies, 1);
  },
);

test("a lost merge response does not retry an ambiguous write", async () => {
  const f = await fixture();
  await recordAssessment.execute({ ...assessment }, ctx);
  f.replyToMerge(new Error("connection lost"));
  await expect(f.mergeResult()).rejects.toThrow("could not confirm");
  assert.lengthOf(f.mergeBodies, 1);
});

test("an invalid merge response cannot claim success", async () => {
  const f = await fixture();
  await recordAssessment.execute({ ...assessment }, ctx);
  f.replyToMerge(Response.json({ sha: "merged", message: "Merged" }));
  await expect(f.mergeResult()).rejects.toThrow("could not confirm");
  assert.lengthOf(f.mergeBodies, 1);
});

test("GitHub's explicit merged-false response remains visible", async () => {
  const f = await fixture();
  await recordAssessment.execute({ ...assessment }, ctx);
  const reply = { merged: false, sha, message: "Not merged" };
  f.replyToMerge(Response.json(reply));
  assert.deepEqual(await f.mergeResult(), reply);
  assert.lengthOf(f.mergeBodies, 1);
});
