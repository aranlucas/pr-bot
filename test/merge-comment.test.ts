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
  readonly merged?: boolean;
  readonly mergeThrows?: boolean;
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

      if (path.endsWith("/merge")) {
        return Promise.resolve(
          Response.json(
            { merged: options.merged ?? true, sha: "merged", message: "GitHub merge result" },
            { status: options.mergeThrows ? 405 : 200 },
          ),
        );
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

await test("posts the review reason and exact commit before merging", async () => {
  const f = fixture();
  await f.github.merge(target, "reviewed-head", "squash", reason);
  assert.deepEqual(f.calls, [
    "GET /repos/acme/app/issues/7/comments",
    "POST /repos/acme/app/issues/7/comments",
    "PUT /repos/acme/app/pulls/7/merge",
  ]);
  assert.ok(f.bodies[0].includes(reason));
  assert.ok(f.bodies[0].includes("reviewed-head"));
  assert.ok(f.bodies[0].includes("approval, CI"));
});

await test("reuses only this App's existing explanation for the same commit", async () => {
  const f = fixture({
    comments: [
      {
        id: 1,
        body: "<!-- pr-bot:merge:reviewed-head -->",
        user: { login: "author", type: "User" },
      },
      {
        id: 2,
        body: "<!-- pr-bot:merge:reviewed-head -->",
        user: { login: "other[bot]", type: "Bot" },
      },
      {
        id: 3,
        body: "<!-- pr-bot:merge:old-head -->",
        user: { login: "pr-bot[bot]", type: "Bot" },
      },
      {
        id: 4,
        body: "<!-- pr-bot:merge:reviewed-head -->",
        user: { login: "pr-bot[bot]", type: "Bot" },
      },
    ],
  });

  await f.github.merge(target, "reviewed-head", "squash", reason);

  assert.equal(f.calls[1], "PATCH /repos/acme/app/issues/comments/4");
});

await test("a forged explanation from the PR author does not replace the bot's comment", async () => {
  const f = fixture({
    comments: [
      {
        id: 1,
        body: "<!-- pr-bot:merge:reviewed-head -->",
        user: { login: "author", type: "User" },
      },
    ],
  });

  await f.github.merge(target, "reviewed-head", "squash", reason);
  assert.equal(f.calls[1], "POST /repos/acme/app/issues/7/comments");
});

await test("a failed explanation prevents the merge request", async () => {
  const f = fixture({ commentFails: true });
  await assert.rejects(f.github.merge(target, "reviewed-head", "squash", reason));
  assert.ok(f.calls.every((call) => !call.startsWith("PUT")));
});

await test("a rejected merge updates its explanation with GitHub's result", async () => {
  const f = fixture({ merged: false });
  const result = await f.github.merge(target, "reviewed-head", "squash", reason);
  assert.equal(result.merged, false);
  assert.ok(f.bodies[1].includes("Not merged."));
  assert.ok(f.bodies[1].includes("GitHub merge result"));
  assert.equal(f.calls.at(-1), "PATCH /repos/acme/app/issues/comments/123");
});

await test("a failed merge request updates the explanation before surfacing the error", async () => {
  const f = fixture({ mergeThrows: true });
  await assert.rejects(f.github.merge(target, "reviewed-head", "squash", reason));
  assert.ok(f.bodies[1].includes("Merge stopped or unconfirmed."));
});

await test("the PR lease is checked again after posting and before merging", async () => {
  const f = fixture();
  await assert.rejects(
    f.github.merge(target, "reviewed-head", "squash", reason, () =>
      Promise.reject(new Error("Lease expired")),
    ),
    { message: "Lease expired" },
  );
  assert.ok(f.calls.every((call) => !call.startsWith("PUT")));
  assert.ok(f.bodies[1].includes("Merge stopped or unconfirmed."));
});
