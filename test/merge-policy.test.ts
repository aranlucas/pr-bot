import { assert, beforeEach, expect, test, vi } from "vitest";
import { github } from "@github-tools/eve-extension/tools";
import type { ToolContext } from "eve/tools";
import type { ApprovalContext } from "eve/tools/approval";
import { z } from "zod";
import githubMount from "../agent/extensions/github.js";
import type { assessmentInput } from "../agent/lib/merge-assessment.js";
import { mergeAssessment } from "../agent/lib/merge-assessment.js";
import recordAssessment from "../agent/tools/record-merge-assessment.js";

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

    if (path === "/repos/policy/app/pulls/42/reviews") {
      return Promise.resolve(Response.json(data.reviews));
    }

    if (path === `/repos/policy/app/commits/${sha}/check-runs`) {
      return Promise.resolve(
        Response.json({ total_count: data.checkTotal, check_runs: data.checkRuns }),
      );
    }

    if (path === `/repos/policy/app/commits/${sha}/status`) {
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
