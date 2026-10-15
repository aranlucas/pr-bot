import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createGitHub } from "@/github";

interface CommentAuthor {
  readonly login: string;
  readonly type: string;
}

interface ExistingComment {
  readonly id: number;
  readonly body: string;
  readonly user: CommentAuthor;
}

interface FixtureOptions {
  readonly comments?: readonly ExistingComment[];
  readonly commentFails?: boolean;
}

const target = { repository: "acme/app", number: 7, installationId: 99, delivery: "one" };

const reason = "The added test covers the regression and the change preserves existing behavior.";

function fixture(options: FixtureOptions = {}) {
  const calls: string[] = [];
  const bodies: string[] = [];

  const github = createGitHub({
    token: "test",
    appSlug: "pr-bot",
    fetch: (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);

      if (method === "GET") {
        const response = Response.json(options.comments ?? []);
        Object.defineProperty(response, "url", { value: url });

        return Promise.resolve(response);
      }

      bodies.push(z.string().parse(init?.body));

      return Promise.resolve(
        Response.json(
          { id: 123, message: "Comment failed" },
          { status: options.commentFails ? 403 : 200 },
        ),
      );
    },
  });

  return { github, calls, bodies };
}

await test("posts the agent review without attempting a merge", async () => {
  const f = fixture();
  await f.github.postComment(target, "reviewed-head", "Missing tests\nConcrete defect");
  assert.deepEqual(f.calls, [
    "GET /repos/acme/app/issues/7/comments",
    "POST /repos/acme/app/issues/7/comments",
  ]);
  assert.ok(f.bodies[0].includes("pr-bot:review:reviewed-head"));
  assert.ok(f.bodies[0].includes("Missing tests"));
  assert.ok(f.bodies[0].includes("Concrete defect"));
});

await test("updates only this App's review comment for the same commit", async () => {
  const f = fixture({
    comments: [
      {
        id: 1,
        body: "<!-- pr-bot:review:reviewed-head -->",
        user: { login: "author", type: "User" },
      },
      {
        id: 2,
        body: "<!-- pr-bot:review:reviewed-head -->",
        user: { login: "other[bot]", type: "Bot" },
      },
      {
        id: 3,
        body: "<!-- pr-bot:review:old-head -->",
        user: { login: "pr-bot[bot]", type: "Bot" },
      },
      {
        id: 4,
        body: "<!-- pr-bot:review:reviewed-head -->",
        user: { login: "pr-bot[bot]", type: "Bot" },
      },
    ],
  });

  await f.github.postComment(target, "reviewed-head", reason);

  assert.equal(f.calls[1], "PATCH /repos/acme/app/issues/comments/4");
});

await test("an unchanged review comment is not rewritten on later deliveries", async () => {
  const first = fixture();
  await first.github.postComment(target, "reviewed-head", reason);

  const body = z.object({ body: z.string() }).parse(JSON.parse(first.bodies[0])).body;

  const next = fixture({
    comments: [{ id: 4, body, user: { login: "pr-bot[bot]", type: "Bot" } }],
  });

  await next.github.postComment(target, "reviewed-head", reason);

  assert.deepEqual(next.calls, ["GET /repos/acme/app/issues/7/comments"]);
});
