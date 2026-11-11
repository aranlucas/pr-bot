import { assert, describe, test, vi } from "vitest";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { github } from "@github-tools/eve-extension/tools";
import { z } from "zod";
import githubMount from "../agent/extensions/github.js";

const repositoryWrites = [
  "createLabel",
  "updatePullRequestComment",
  "deletePullRequestComment",
] as const;

const pullNumberWrites = [
  "updatePullRequest",
  "addPullRequestComment",
  "replyToReviewComment",
  "requestReviewers",
] as const;

const issueNumberWrites = ["addLabels", "removeLabel"] as const;

type Write =
  | (typeof repositoryWrites)[number]
  | (typeof pullNumberWrites)[number]
  | (typeof issueNumberWrites)[number]
  | "createOrUpdateFile";

// A type alias, not an interface: ApprovalContext.toolInput needs an index signature.
type WriteInput = {
  owner: string;
  repo: string;
  pullNumber?: number;
  issueNumber?: number;
  commentId?: number;
  branch?: string;
  path?: string;
  message?: string;
  content?: string;
};

interface Signed {
  repository: string;
  kind?: "pull_request" | "review_thread" | "issue";
  number?: number;
}

const signedPr: Signed = { repository: "Acme/App", kind: "pull_request", number: 7 };

function unexpected(): never {
  throw new Error("Unexpected fixture operation");
}

// Collapses an approval result to the decision the gate made.
async function approve(
  tool: Write,
  signed: Signed | null,
  toolInput: WriteInput,
): Promise<"allowed" | "denied" | "other"> {
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
              attributes: {
                repository: signed.repository,
                ...(signed.kind && { conversation_kind: signed.kind }),
                ...(signed.number !== undefined && {
                  pull_request_number: String(signed.number),
                }),
              },
            }
          : null,
      },
    },
    toolInput,
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

  const result: ApprovalStatus = await policy(ctx);

  if (result === "not-applicable") {
    return "allowed";
  }

  return z.object({ type: z.literal("denied") }).safeParse(result).success ? "denied" : "other";
}

for (const tool of repositoryWrites) {
  test.each([
    { signed: signedPr, owner: "acme", repo: "app", allowed: true },
    { signed: signedPr, owner: "acme", repo: "other", allowed: false },
    { signed: signedPr, owner: "other", repo: "app", allowed: false },
    { signed: null, owner: "acme", repo: "app", allowed: false },
  ])(
    `${tool} confines writes to the signed repository: %j`,
    async ({ signed, owner, repo, allowed }) => {
      const result = await approve(tool, signed, { owner, repo, commentId: 1 });

      assert.strictEqual(result, allowed ? "allowed" : "denied");
    },
  );
}

const pullRequestCases = [
  { name: "the signed PR", signed: signedPr, owner: "acme", repo: "app", number: 7, allowed: true },
  {
    name: "a review thread on the signed PR",
    signed: { ...signedPr, kind: "review_thread" as const },
    owner: "acme",
    repo: "app",
    number: 7,
    allowed: true,
  },
  {
    name: "another PR in the signed repository",
    signed: signedPr,
    owner: "acme",
    repo: "app",
    number: 8,
    allowed: false,
  },
  {
    name: "the same number in another repository",
    signed: signedPr,
    owner: "acme",
    repo: "other",
    number: 7,
    allowed: false,
  },
  {
    name: "an issue conversation",
    signed: { repository: "Acme/App", kind: "issue" as const },
    owner: "acme",
    repo: "app",
    number: 7,
    allowed: false,
  },
  {
    name: "an unsigned session",
    signed: null,
    owner: "acme",
    repo: "app",
    number: 7,
    allowed: false,
  },
];

for (const tool of pullNumberWrites) {
  test.each(pullRequestCases)(`${tool} only targets the signed PR: $name`, async (entry) => {
    const result = await approve(tool, entry.signed, {
      owner: entry.owner,
      repo: entry.repo,
      pullNumber: entry.number,
    });

    assert.strictEqual(result, entry.allowed ? "allowed" : "denied");
  });
}

for (const tool of issueNumberWrites) {
  test.each(pullRequestCases)(`${tool} only labels the signed PR: $name`, async (entry) => {
    const result = await approve(tool, entry.signed, {
      owner: entry.owner,
      repo: entry.repo,
      issueNumber: entry.number,
    });

    assert.strictEqual(result, entry.allowed ? "allowed" : "denied");
  });
}

interface PullRequestFixture {
  number: number;
  state: string;
  head: { ref: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } };
}

describe("createOrUpdateFile", () => {
  const sameRepositoryHead: PullRequestFixture = {
    number: 7,
    state: "open",
    head: { ref: "feature", repo: { full_name: "Acme/App" } },
    base: { ref: "main", repo: { full_name: "Acme/App" } },
  };

  // A null PR makes the read fail with 404. Octokit retries 5xx responses.
  function stubGitHub(pr: PullRequestFixture | null = sameRepositoryHead) {
    const calls: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation((request, init) => {
      const url = new URL(request instanceof Request ? request.url : request.toString());
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);
      const authorization = new Headers(init?.headers).get("authorization");

      if (url.pathname === "/repos/Acme/App/installation") {
        assert.ok(authorization?.startsWith("bearer ey"));

        return Promise.resolve(Response.json({ id: 31 }));
      }

      if (url.pathname === "/app/installations/31/access_tokens") {
        return Promise.resolve(
          Response.json({
            token: "write-policy-token",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: {},
            repository_selection: "selected",
          }),
        );
      }

      if (url.pathname === "/repos/Acme/App/pulls/7") {
        assert.strictEqual(authorization, "token write-policy-token");

        return Promise.resolve(
          pr ? Response.json(pr) : Response.json({ message: "Not Found" }, { status: 404 }),
        );
      }

      throw new Error(`Unexpected API path: ${method} ${url.pathname}`);
    });

    return calls;
  }

  const fix = { owner: "acme", repo: "app", path: "src/app.ts", message: "fix", content: "x" };

  test("commits to the signed PR's same-repository head branch", async () => {
    const calls = stubGitHub();

    assert.strictEqual(
      await approve("createOrUpdateFile", signedPr, { ...fix, branch: "feature" }),
      "allowed",
    );
    assert.include(calls, "GET /repos/Acme/App/pulls/7");
  });

  test.each([
    { name: "an omitted branch, which defaults to the default branch", branch: undefined },
    { name: "an empty branch", branch: "" },
  ])("denies $name without reading GitHub", async ({ branch }) => {
    const calls = stubGitHub();

    assert.strictEqual(await approve("createOrUpdateFile", signedPr, { ...fix, branch }), "denied");
    assert.deepEqual(calls, []);
  });

  test("denies the base branch", async () => {
    stubGitHub();

    assert.strictEqual(
      await approve("createOrUpdateFile", signedPr, { ...fix, branch: "main" }),
      "denied",
    );
  });

  test("denies another branch in the signed repository", async () => {
    stubGitHub();

    assert.strictEqual(
      await approve("createOrUpdateFile", signedPr, { ...fix, branch: "release" }),
      "denied",
    );
  });

  test("denies a fork head even when the base repository has a branch of that name", async () => {
    stubGitHub({
      ...sameRepositoryHead,
      head: { ref: "feature", repo: { full_name: "fork/app" } },
    });

    assert.strictEqual(
      await approve("createOrUpdateFile", signedPr, { ...fix, branch: "feature" }),
      "denied",
    );
  });

  test("denies a head whose repository was deleted", async () => {
    stubGitHub({ ...sameRepositoryHead, head: { ref: "feature", repo: null } });

    assert.strictEqual(
      await approve("createOrUpdateFile", signedPr, { ...fix, branch: "feature" }),
      "denied",
    );
  });

  test("denies a closed PR", async () => {
    stubGitHub({ ...sameRepositoryHead, state: "closed" });

    assert.strictEqual(
      await approve("createOrUpdateFile", signedPr, { ...fix, branch: "feature" }),
      "denied",
    );
  });

  test("denies when the PR cannot be read", async () => {
    stubGitHub(null);

    assert.strictEqual(
      await approve("createOrUpdateFile", signedPr, { ...fix, branch: "feature" }),
      "denied",
    );
  });

  test.each([
    { name: "another repository", signed: signedPr, input: { ...fix, repo: "other" } },
    { name: "an issue conversation", signed: { repository: "Acme/App", kind: "issue" as const } },
    { name: "an unsigned session", signed: null },
  ])("denies $name without reading GitHub", async ({ signed, input = fix }) => {
    const calls = stubGitHub();

    assert.strictEqual(
      await approve("createOrUpdateFile", signed, { ...input, branch: "feature" }),
      "denied",
    );
    assert.deepEqual(calls, []);
  });
});
