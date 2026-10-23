import { createHmac } from "node:crypto";
import { assert, beforeEach, describe, test, vi } from "vitest";
import type { ChannelSendOptions, RouteHandlerArgs, Session } from "eve/channels";
import type {
  GitHubChannelState,
  GitHubConversationKind,
  GitHubEventContext,
} from "eve/channels/github";
import initialChannel, { githubEvents } from "../agent/channels/github.js";

let channel = initialChannel;

interface Delivery {
  readonly address: string;
  readonly options: ChannelSendOptions<GitHubChannelState>;
}

interface CompletionCase {
  kind: GitHubConversationKind;
  message: string;
  posted: boolean;
}

const repository = { id: 123, full_name: "Acme/App", name: "App", owner: { login: "Acme" } };

const changedFile = {
  filename: "app.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-export const enabled = false;\n+export const enabled = true;",
};

const envelope = {
  repository,
  installation: { id: 99 },
  sender: { id: 10, login: "author", type: "User" },
};

const submittedReview = {
  user: { login: "patchling-pr[bot]" },
  commit_id: "head",
  state: "APPROVED",
  submitted_at: "2026-10-23T00:00:00Z",
};

function automaticEvent() {
  return JSON.stringify({
    ...envelope,
    action: "synchronize",
    pull_request: {
      number: 7,
      state: "open",
      merged: false,
      draft: false,
      labels: [],
      head: { sha: "head" },
      base: { sha: "base" },
    },
  });
}

function unexpected(): never {
  throw new Error("Unexpected fixture operation");
}

test.each([
  {
    kind: "pull_request",
    message: "The PR was already merged. I finish the turn silently.",
    posted: false,
  },
  { kind: "pull_request", message: "The PR is closed. I finish the turn silently.", posted: false },
  { kind: "pull_request", message: "Review published. No concrete defects found.", posted: false },
  {
    kind: "review_thread",
    message: "The PR was already merged. I finish the turn silently.",
    posted: false,
  },
  { kind: "issue", message: "Here is the requested explanation.", posted: true },
] satisfies CompletionCase[])(
  "assistant completion on $kind: $message",
  async ({ kind, message, posted }) => {
    const post = vi.fn().mockResolvedValue({ id: 1 });

    const context: GitHubEventContext = {
      conversation: {
        kind,
        issueNumber: kind === "issue" ? 7 : null,
        pullRequestNumber: kind === "issue" ? null : 7,
      },
      repository: { id: 123, fullName: "Acme/App", name: "App", owner: "Acme", private: false },
      github: {
        installationId: 99,
        repository: { id: 123, fullName: "Acme/App", name: "App", owner: "Acme", private: false },
        request: unexpected,
      },
      thread: { kind, post, react: unexpected },
      state: {
        baseRef: null,
        baseSha: null,
        checkoutPath: null,
        conversationKind: kind,
        defaultBranch: null,
        headRef: null,
        headSha: null,
        installationId: 99,
        issueNumber: kind === "issue" ? 7 : null,
        owner: "Acme",
        pullRequestNumber: kind === "issue" ? null : 7,
        repo: "App",
        repositoryId: 123,
        reviewCommentId: null,
        reviewThreadRootCommentId: null,
        triggeringCommentId: null,
        triggeringUserLogin: null,
      },
    };

    const completed = githubEvents["message.completed"];
    assert.isDefined(completed);

    await completed(
      { finishReason: "stop", message, sequence: 1, stepIndex: 1, turnId: "turn" },
      context,
      {
        session: {
          id: "session",
          auth: { current: null, initiator: null },
          turn: { id: "turn", sequence: 1 },
        },
        getSandbox: unexpected,
      },
    );

    assert.deepEqual(post.mock.calls, posted ? [[message]] : []);
  },
);

function fixture() {
  const deliveries: Delivery[] = [];
  const pending: Promise<unknown>[] = [];

  const session: Session = {
    id: "session",
    send: unexpected,
    respond: unexpected,
    cancel: unexpected,
    compact: unexpected,
    clear: unexpected,
    reset: unexpected,
    getEventStream: unexpected,
    getStreamTailIndex: unexpected,
  };

  const args: RouteHandlerArgs<GitHubChannelState> = {
    from: (address) => ({
      create: unexpected,
      send: (_message, options) => {
        deliveries.push({ address, options });

        return Promise.resolve(session);
      },
      respond: unexpected,
      cancel: unexpected,
      compact: unexpected,
      clear: unexpected,
      reset: unexpected,
    }),
    resolveSession: unexpected,
    attachSession: unexpected,
    to: unexpected,
    params: {},
    waitUntil: (task) => {
      pending.push(task);
    },
    requestIp: null,
    describe: unexpected,
    listSkillFiles: unexpected,
    readSkill: unexpected,
    invokeTool: unexpected,
  };

  const route =
    channel.routes.find((candidate) => candidate.transport !== "websocket") ?? unexpected();

  async function dispatch(name: string, body: string, secret = "secret") {
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

    const response = await route.handler(
      new Request("https://example.com/eve/v1/github", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-github-event": name,
          "x-github-delivery": "delivery",
          "x-hub-signature-256": signature,
        },
      }),
      args,
    );

    await Promise.all(pending);

    return response;
  }

  return { dispatch, deliveries };
}

describe("native GitHub webhook integration", () => {
  beforeEach(async () => {
    vi.resetModules();
    channel = (await import("../agent/channels/github.js")).default;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;

      switch (path) {
        case "/app":
          return Promise.resolve(Response.json({ id: 5335315, slug: "patchling-pr" }));
        case "/repos/Acme/App/installation":
          return Promise.resolve(Response.json({ id: 99 }));
        case "/app/installations/99/access_tokens":
          return Promise.resolve(
            Response.json({
              token: "installation-token",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }),
          );
        case "/repos/Acme/App/pulls/7":
          return Promise.resolve(
            Response.json({
              number: 7,
              title: "Fix",
              state: "open",
              merged: false,
              draft: false,
              labels: [],
              head: { sha: "head" },
              base: { sha: "base" },
            }),
          );
        case "/repos/Acme/App/pulls/7/files":
          return Promise.resolve(Response.json([changedFile]));
        case "/repos/Acme/App/pulls/7/reviews":
          return Promise.resolve(Response.json([]));
        case "/repos/Acme/App/compare/base...head":
          return Promise.resolve(Response.json({ files: [changedFile] }));
        default:
          throw new Error(`Unexpected GitHub API request: ${path}`);
      }
    });
  });

  test("the native signed webhook channel dispatches a PR with App installation context", async () => {
    const f = fixture();

    const response = await f.dispatch(
      "pull_request",
      JSON.stringify({
        ...envelope,
        action: "opened",
        pull_request: {
          number: 7,
          state: "open",
          merged: false,
          draft: false,
          labels: [],
          head: { sha: "head" },
          base: { sha: "base" },
        },
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(f.deliveries.length, 1);
    assert.strictEqual(f.deliveries[0].address, "repo:123:pull:7");
    assert.strictEqual(f.deliveries[0].options.auth?.authenticator, "github-webhook");
    assert.strictEqual(f.deliveries[0].options.auth?.attributes?.installation_id, "99");
    assert.strictEqual(f.deliveries[0].options.state.installationId, 99);
  });

  test("completed check runs and check suites do not start a turn", async () => {
    const f = fixture();

    const check = {
      id: 1,
      head_sha: "head",
      status: "completed",
      conclusion: "success",
      app: { id: 2, slug: "github-actions" },
      pull_requests: [{ number: 7 }],
    };

    const responses = await Promise.all(
      ["check_run", "check_suite"].map((event) =>
        f.dispatch(event, JSON.stringify({ ...envelope, action: "completed", [event]: check })),
      ),
    );

    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
    );
    assert.strictEqual(f.deliveries.length, 0);
  });

  test.each(["APPROVED", "COMMENTED", "CHANGES_REQUESTED"])(
    "a submitted bot %s review suppresses repeated automatic events for its head",
    async (state) => {
      const f = fixture();
      const fetch = vi.mocked(globalThis.fetch).getMockImplementation();
      assert.ok(fetch);
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());

        if (url.pathname.endsWith("/reviews")) {
          return Promise.resolve(Response.json([{ ...submittedReview, state }]));
        }

        return fetch(input, init);
      });

      await f.dispatch("pull_request", automaticEvent());
      await f.dispatch("pull_request", automaticEvent());

      assert.lengthOf(f.deliveries, 0);
    },
  );

  test.each([
    { ...submittedReview, commit_id: "old-head" },
    { ...submittedReview, user: { login: "human" } },
    { ...submittedReview, user: { login: "another-app[bot]" } },
    { ...submittedReview, user: { login: "aranlucas-pr-bot[bot]" } },
    { ...submittedReview, user: null },
    { ...submittedReview, state: "PENDING", submitted_at: null },
    { ...submittedReview, state: "DISMISSED" },
  ])("an unrelated or unsubmitted review still permits an automatic review: %j", async (review) => {
    const f = fixture();
    const fetch = vi.mocked(globalThis.fetch).getMockImplementation();
    assert.ok(fetch);
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());

      return url.pathname.endsWith("/reviews")
        ? Promise.resolve(Response.json([review]))
        : fetch(input, init);
    });

    await f.dispatch("pull_request", automaticEvent());

    assert.lengthOf(f.deliveries, 1);
  });

  test("duplicate detection reads subsequent pages and uses the signed installation", async () => {
    const f = fixture();
    const fetch = vi.mocked(globalThis.fetch).getMockImplementation();
    assert.ok(fetch);
    const pages: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());

      if (url.pathname.endsWith("/reviews")) {
        assert.strictEqual(
          new Headers(init?.headers).get("authorization"),
          "token installation-token",
        );
        assert.strictEqual(url.searchParams.get("per_page"), "100");
        const page = url.searchParams.get("page") ?? "";
        pages.push(page);

        return Promise.resolve(
          Response.json(
            page === "1"
              ? Array.from({ length: 100 }, () => ({ ...submittedReview, commit_id: "old-head" }))
              : [submittedReview],
            page === "1"
              ? {
                  headers: {
                    link: '<https://api.github.com/repos/Acme/App/pulls/7/reviews?per_page=100&page=2>; rel="next"',
                  },
                }
              : {},
          ),
        );
      }

      return fetch(input, init);
    });

    await f.dispatch("pull_request", automaticEvent());

    assert.deepEqual(pages, ["1", "2"]);
    assert.lengthOf(f.deliveries, 0);
  });

  test.each([
    { head: { sha: "new-head" } },
    { state: "closed" },
    { merged: true },
    { draft: true },
    { labels: [{ name: "PR-Bot:Paused" }] },
  ])("a stale automatic event cannot start a review: %j", async (changes) => {
    const f = fixture();
    const fetch = vi.mocked(globalThis.fetch).getMockImplementation();
    assert.ok(fetch);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const response = await fetch(input, init);

      return url.pathname.endsWith("/pulls/7")
        ? Response.json({ ...(await response.json()), ...changes })
        : response;
    });

    await f.dispatch("pull_request", automaticEvent());

    assert.lengthOf(f.deliveries, 0);
  });

  test.each([
    "PR read failed",
    "review read failed",
    "malformed reviews",
    "App read failed",
    "malformed App",
  ])(
    "automatic review is skipped when duplicate detection cannot be verified: %s",
    async (condition) => {
      const f = fixture();
      const fetch = vi.mocked(globalThis.fetch).getMockImplementation();
      assert.ok(fetch);
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());

        if (
          (condition === "App read failed" && url.pathname === "/app") ||
          (condition === "PR read failed" && url.pathname.endsWith("/pulls/7")) ||
          (condition === "review read failed" && url.pathname.endsWith("/reviews"))
        ) {
          return Promise.resolve(Response.json({ message: "Not found" }, { status: 404 }));
        }

        if (condition === "malformed App" && url.pathname === "/app") {
          return Promise.resolve(Response.json({ id: 5335315, slug: "" }));
        }

        if (condition === "malformed reviews" && url.pathname.endsWith("/reviews")) {
          return Promise.resolve(Response.json({ error: "Unexpected response" }));
        }

        return fetch(input, init);
      });

      const response = await f.dispatch("pull_request", automaticEvent());

      assert.strictEqual(response.status, 200);
      assert.lengthOf(f.deliveries, 0);
    },
  );

  test("an explicit review request can reassess a head with a completed bot review", async () => {
    const f = fixture();
    const fetch = vi.mocked(globalThis.fetch).getMockImplementation();
    assert.ok(fetch);
    const reviewRead = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());

      if (url.pathname.endsWith("/reviews")) {
        reviewRead();

        return Promise.resolve(Response.json([submittedReview]));
      }

      return fetch(input, init);
    });

    await f.dispatch("pull_request", automaticEvent());
    assert.lengthOf(f.deliveries, 0);
    await f.dispatch(
      "issue_comment",
      JSON.stringify({
        ...envelope,
        action: "created",
        issue: {
          number: 7,
          pull_request: { url: "https://api.github.com/repos/Acme/App/pulls/7" },
        },
        comment: { id: 1, body: "@aranlucas-pr-bot review again", user: envelope.sender },
      }),
    );

    assert.lengthOf(f.deliveries, 1);
    assert.strictEqual(reviewRead.mock.calls.length, 1);
  });

  test("the native channel rejects forged webhook signatures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture();
    const response = await f.dispatch("pull_request", JSON.stringify(envelope), "forged");
    assert.strictEqual(response.status, 401);
    assert.strictEqual(f.deliveries.length, 0);
    assert.strictEqual(warn.mock.calls.length, 1);
    assert.strictEqual(
      warn.mock.calls[0][0],
      "[eve:github.channel] github inbound verification failed",
    );
  });

  test.each(["opened", "reopened", "ready_for_review", "synchronize"])(
    "reviews an open PR on %s",
    async (action) => {
      const f = fixture();

      const response = await f.dispatch(
        "pull_request",
        JSON.stringify({
          ...envelope,
          action,
          pull_request: {
            number: 7,
            state: "open",
            merged: false,
            draft: false,
            labels: [],
            head: { sha: "head" },
            base: { sha: "base" },
          },
        }),
      );

      assert.strictEqual(response.status, 200);
      assert.strictEqual(f.deliveries.length, 1);
      assert.strictEqual(f.deliveries[0].address, "repo:123:pull:7");
      assert.ok(
        f.deliveries[0].options.context?.some((entry) =>
          entry.includes(`Automatic review: ${action}, event head head`),
        ),
      );
      assert.ok(
        f.deliveries[0].options.context?.some(
          (entry) =>
            entry.includes(changedFile.filename) && entry.includes("+export const enabled = true;"),
        ),
      );
    },
  );

  test.each([
    { action: "synchronize", state: "open", merged: false, draft: true, labels: [] },
    {
      action: "opened",
      state: "open",
      merged: false,
      draft: false,
      labels: [{ name: "pr-bot:paused" }],
    },
    {
      action: "synchronize",
      state: "open",
      merged: false,
      draft: false,
      labels: [{ name: "pr-bot:paused" }],
    },
    { action: "reopened", state: "closed", merged: false, draft: false, labels: [] },
    {
      action: "synchronize",
      state: "open",
      merged: false,
      draft: false,
      labels: [{ name: "PR-Bot:Paused" }],
    },
    { action: "synchronize", state: "closed", merged: true, draft: false, labels: [] },
    { action: "closed", state: "closed", merged: true, draft: false, labels: [] },
    { action: "labeled", state: "open", merged: false, draft: false, labels: [] },
    { action: "edited", state: "open", merged: false, draft: false, labels: [] },
  ])(
    "does not automatically review $action with state=$state, merged=$merged, draft=$draft, labels=$labels",
    async ({ action, ...pr }) => {
      const f = fixture();

      const response = await f.dispatch(
        "pull_request",
        JSON.stringify({
          ...envelope,
          action,
          pull_request: { number: 7, ...pr, head: { sha: "head" }, base: { sha: "base" } },
        }),
      );

      assert.strictEqual(response.status, 200);
      assert.strictEqual(f.deliveries.length, 0);
    },
  );

  test("a mention can request a review on a paused PR", async () => {
    const f = fixture();

    const response = await f.dispatch(
      "issue_comment",
      JSON.stringify({
        ...envelope,
        action: "created",
        issue: {
          number: 7,
          state: "open",
          labels: [{ name: "pr-bot:paused" }],
          pull_request: { url: "https://api.github.com/repos/Acme/App/pulls/7" },
        },
        comment: { id: 1, body: "@aranlucas-pr-bot review only", user: envelope.sender },
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(f.deliveries.length, 1);
    assert.strictEqual(f.deliveries[0].address, "repo:123:pull:7");
    assert.ok(
      f.deliveries[0].options.context?.some(
        (entry) =>
          entry.includes(changedFile.filename) && entry.includes("+export const enabled = true;"),
      ),
    );
  });

  test("an inline mention follows the original finding's review thread", async () => {
    const f = fixture();

    const response = await f.dispatch(
      "pull_request_review_comment",
      JSON.stringify({
        ...envelope,
        action: "created",
        pull_request: { number: 7, head: { sha: "head" }, base: { sha: "base" } },
        comment: {
          id: 12,
          in_reply_to_id: 10,
          body: "@aranlucas-pr-bot explain this finding",
          user: envelope.sender,
          path: "app.ts",
        },
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(f.deliveries.length, 1);
    assert.strictEqual(f.deliveries[0].address, "repo:123:pull:7:review-comment:10");
    assert.strictEqual(
      f.deliveries[0].options.auth?.attributes?.conversation_kind,
      "review_thread",
    );
  });
});

test.each([true, false])(
  "a mention dispatches only while the current PR is not a draft (draft=%s)",
  async (draft) => {
    const f = fixture();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;

      if (path.endsWith("/installation")) {
        return Promise.resolve(Response.json({ id: 99 }));
      }

      if (path.endsWith("/access_tokens")) {
        return Promise.resolve(
          Response.json({
            token: "token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
        );
      }

      if (path.endsWith("/pulls/7")) {
        return Promise.resolve(
          Response.json({
            number: 7,
            state: "open",
            merged: false,
            draft,
            head: { sha: "head" },
            base: { sha: "base", ref: "main" },
          }),
        );
      }

      if (path.endsWith("/files")) {
        return Promise.resolve(Response.json([changedFile]));
      }

      throw new Error(`Unexpected GitHub API request: ${path}`);
    });

    const response = await f.dispatch(
      "issue_comment",
      JSON.stringify({
        ...envelope,
        action: "created",
        issue: {
          number: 7,
          pull_request: { url: "https://api.github.com/repos/Acme/App/pulls/7" },
        },
        comment: { id: 1, body: "@aranlucas-pr-bot review", user: envelope.sender },
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.lengthOf(f.deliveries, draft ? 0 : 1);
  },
);
