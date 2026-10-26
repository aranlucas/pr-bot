import { assert, test, vi } from "vitest";
import githubExtension from "@github-tools/eve-extension";
import { github } from "@github-tools/eve-extension/tools";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import githubMount from "../agent/extensions/github.js";

function unexpected(): never {
  throw new Error("Unexpected fixture operation");
}

const ctx: ToolContext = {
  session: {
    id: "session",
    turn: { id: "turn", sequence: 1 },
    auth: { current: null, initiator: null },
  },
  getSandbox: unexpected,
  getToken: unexpected,
  requireAuth: unexpected,
  abortSignal: new AbortController().signal,
  callId: "call",
  toolName: "github__addPullRequestComment",
  messages: [],
};

test("the mounted extension publishes reviews, replies, and pause controls through the GitHub App", async () => {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const authorization = new Headers(init?.headers).get("authorization");

    if (path === "/repos/acme/app/installation") {
      assert.ok(authorization?.startsWith("bearer ey"));

      return Promise.resolve(Response.json({ id: 99 }));
    }

    if (path === "/app/installations/99/access_tokens") {
      assert.ok(authorization?.startsWith("bearer ey"));

      return Promise.resolve(
        Response.json({
          token: "installation-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: {},
          repository_selection: "all",
        }),
      );
    }

    assert.strictEqual(authorization, "token installation-token");

    if (path === "/repos/acme/app/pulls/42/reviews") {
      assert.deepEqual(JSON.parse(z.string().parse(init?.body)), {
        event: "COMMENT",
        body: "One concrete defect.",
        comments: [
          { path: "app.ts", line: 12, side: "RIGHT", body: "Repeated input charges twice." },
        ],
      });

      return Promise.resolve(
        Response.json({
          id: 100,
          state: "COMMENTED",
          body: "One concrete defect.",
          user: { login: "pr-bot[bot]" },
        }),
      );
    }

    if (path === "/repos/acme/app/pulls/42/comments/101/replies") {
      assert.deepEqual(JSON.parse(z.string().parse(init?.body)), {
        body: "Verified fixed at head-sha.",
      });

      return Promise.resolve(Response.json({ id: 102, user: { login: "pr-bot[bot]" } }));
    }

    if (path === "/repos/acme/app/issues/42/labels") {
      assert.deepEqual(JSON.parse(z.string().parse(init?.body)), { labels: ["pr-bot:paused"] });

      return Promise.resolve(Response.json([{ name: "bug" }, { name: "pr-bot:paused" }]));
    }

    if (path === "/repos/acme/app/issues/42/labels/pr-bot%3Apaused") {
      assert.strictEqual(init?.method, "DELETE");

      return Promise.resolve(Response.json([{ name: "bug" }]));
    }

    if (path === "/repos/acme/app/issues/42/comments") {
      assert.deepEqual(JSON.parse(z.string().parse(init?.body)), {
        body: "No concrete defects found.",
      });

      return Promise.resolve(
        Response.json({
          id: 1,
          html_url: "https://github.com/acme/app/pull/42#issuecomment-1",
          body: "No concrete defects found.",
          user: { login: "pr-bot[bot]" },
        }),
      );
    }

    if (path === "/repos/acme/app/issues/43/comments") {
      return Promise.resolve(Response.json({ message: "Not Found" }, { status: 404 }));
    }

    throw new Error(`Unexpected API path: ${path}`);
  });

  assert.ok(githubMount);
  assert.strictEqual(githubExtension.config.preset, "code-review");
  assert.strictEqual(githubExtension.config.requireApproval, false);
  const resolve = github.events["step.started"];
  assert.ok(resolve);

  const tools = await resolve(undefined, {
    model: null,
    session: ctx.session,
    channel: { kind: "github" },
    messages: [],
  });

  assert.ok(tools.getPullRequestContext);
  assert.ok(tools.listCheckRuns);
  assert.ok(tools.getCombinedStatus);
  assert.ok(tools.addPullRequestComment);
  assert.isUndefined(tools.mergePullRequest);
  assert.ok(tools.createOrUpdateFile);
  assert.isUndefined(tools.createBranch);
  assert.isUndefined(tools.createPullRequest);
  assert.ok(tools.createPullRequestReview);
  assert.ok(tools.replyToReviewComment);
  assert.ok(tools.listPullRequestReviewThreads);
  assert.ok(tools.listIssueComments);
  assert.ok(tools.getIssue);
  assert.ok(tools.listLabels);
  assert.ok(tools.createLabel);
  assert.ok(tools.addLabels);
  assert.ok(tools.removeLabel);
  assert.isUndefined(tools.deleteBranch);
  assert.isUndefined(tools.resolveReviewThread);

  const input = { owner: "acme", repo: "app", pullNumber: 42 };

  const review = await tools.createPullRequestReview.execute(
    {
      ...input,
      event: "COMMENT",
      body: "One concrete defect.",
      comments: [
        { path: "app.ts", line: 12, side: "RIGHT", body: "Repeated input charges twice." },
      ],
    },
    { ...ctx, toolName: "github__createPullRequestReview" },
  );

  assert.strictEqual(z.object({ id: z.number() }).parse(review).id, 100);

  const reply = await tools.replyToReviewComment.execute(
    { ...input, commentId: 101, body: "Verified fixed at head-sha." },
    { ...ctx, toolName: "github__replyToReviewComment" },
  );

  assert.strictEqual(z.object({ id: z.number() }).parse(reply).id, 102);

  await tools.addLabels.execute(
    { owner: input.owner, repo: input.repo, issueNumber: 42, labels: ["pr-bot:paused"] },
    { ...ctx, toolName: "github__addLabels" },
  );
  await tools.removeLabel.execute(
    { owner: input.owner, repo: input.repo, issueNumber: 42, label: "pr-bot:paused" },
    { ...ctx, toolName: "github__removeLabel" },
  );

  const comment = await tools.addPullRequestComment.execute(
    { ...input, body: "No concrete defects found." },
    ctx,
  );

  assert.strictEqual(z.object({ id: z.number() }).parse(comment).id, 1);
  assert.include(tools.addPullRequestComment.description, "at most once per PR");
  // The model sees the posted comment as the summary to update, not a payload to repeat.
  assert.deepEqual(await tools.addPullRequestComment.toModelOutput?.(comment), {
    type: "text",
    value:
      "Posted the PR summary as comment 1 (https://github.com/acme/app/pull/42#issuecomment-1). Do not call addPullRequestComment again for this PR; change the summary with updatePullRequestComment using commentId 1.",
  });

  const failed = await tools.addPullRequestComment.execute(
    { ...input, pullNumber: 43, body: "No concrete defects found." },
    ctx,
  );

  // A failed post keeps GitHub's error so the model does not treat it as published.
  assert.deepEqual(await tools.addPullRequestComment.toModelOutput?.(failed), {
    type: "json",
    value: failed,
  });
  assert.strictEqual(
    z.object({ error: z.object({ code: z.string() }) }).parse(failed).error.code,
    "github_tools.NOT_FOUND",
  );

  assert.ok(calls.includes("POST /repos/acme/app/issues/42/comments"));
  assert.ok(!calls.includes("PUT /repos/acme/app/pulls/42/merge"));
  // All calls target acme/app, so the installation is looked up once.
  assert.strictEqual(calls.filter((call) => call === "GET /repos/acme/app/installation").length, 1);
}, 15_000);
