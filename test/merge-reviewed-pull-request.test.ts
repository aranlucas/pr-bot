import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import mergeReviewedPullRequest from "../agent/tools/merge-reviewed-pull-request.js";
import { githubInstallation } from "@/github";

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
  toolName: "merge-reviewed-pull-request",
  messages: [],
};

const input = { owner: "acme", repo: "app", pullNumber: 42, reviewedHeadSha: "a".repeat(40) };

const merged = { merged: true, sha: "c".repeat(40), message: "Merged" };

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

type HttpCall = { url: URL; init: RequestInit | undefined };

function githubApi(reply: (body: string) => Response | Promise<Response>) {
  vi.stubEnv("GITHUB_APP_ID", "123");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey.export({ type: "pkcs8", format: "pem" }));
  vi.spyOn(githubInstallation, "get").mockReturnValue(99);
  const calls: HttpCall[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((request, init) => {
    const url = new URL(request instanceof Request ? request.url : request.toString());
    calls.push({ url, init });
    const authorization = new Headers(init?.headers).get("authorization");

    if (url.pathname === "/app/installations/99/access_tokens") {
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

    assert.strictEqual(url.origin, "https://api.github.com");
    assert.strictEqual(init?.method, "PUT");
    assert.strictEqual(authorization, "Bearer installation-token");
    assert.strictEqual(init?.signal, ctx.abortSignal);
    assert.strictEqual(init?.redirect, "error");
    assert.deepEqual(JSON.parse(z.string().parse(init?.body)), {
      sha: input.reviewedHeadSha,
      merge_method: "squash",
    });

    return Promise.resolve(reply(z.string().parse(init?.body)));
  });

  return calls;
}

test("merges exactly the reviewed SHA with a GitHub App installation token", async () => {
  const calls = githubApi(() => Response.json(merged));
  assert.deepEqual(await mergeReviewedPullRequest.execute(input, ctx), merged);
  assert.deepEqual(
    calls.map(({ url }) => url.pathname),
    ["/app/installations/99/access_tokens", "/repos/acme/app/pulls/42/merge"],
  );
  const headers = new Headers(calls[1]?.init?.headers);
  assert.strictEqual(headers.get("accept"), "application/vnd.github+json");
  assert.strictEqual(headers.get("content-type"), "application/json");
  assert.strictEqual(headers.get("x-github-api-version"), "2026-03-10");
});

test("a push after review prevents merging and never falls back to a newer head", async () => {
  const currentHead = "b".repeat(40);
  let merges = 0;

  const calls = githubApi((requestBody) => {
    const body = z.object({ sha: z.string() }).parse(JSON.parse(requestBody));

    if (body.sha !== currentHead) {
      return Response.json({ message: "Head SHA does not match" }, { status: 409 });
    }

    merges += 1;

    return Response.json(merged);
  });

  await assert.rejects(
    Promise.resolve(mergeReviewedPullRequest.execute(input, ctx)),
    /Refresh.*review its current head/,
  );
  assert.strictEqual(merges, 0);
  assert.strictEqual(calls.filter(({ init }) => init?.method === "PUT").length, 1);
});

test.each([403, 405, 422, 500])(
  "HTTP %i stays a failure without leaking the API body or retrying",
  async (status) => {
    const calls = githubApi(() => Response.json({ message: "installation-token" }, { status }));
    await assert.rejects(Promise.resolve(mergeReviewedPullRequest.execute(input, ctx)), {
      message: `GitHub merge failed (HTTP ${status})`,
    });
    assert.strictEqual(calls.filter(({ init }) => init?.method === "PUT").length, 1);
  },
);

test("a transport failure is not retried", async () => {
  const calls = githubApi(() => Promise.reject(new Error("connection lost")));
  await assert.rejects(
    Promise.resolve(mergeReviewedPullRequest.execute(input, ctx)),
    /connection lost/,
  );
  assert.strictEqual(calls.filter(({ init }) => init?.method === "PUT").length, 1);
});

test("an invalid success payload is rejected", async () => {
  const calls = githubApi(() => Response.json({ message: "Merged", sha: "c".repeat(40) }));
  await assert.rejects(Promise.resolve(mergeReviewedPullRequest.execute(input, ctx)), z.ZodError);
  assert.strictEqual(calls.filter(({ init }) => init?.method === "PUT").length, 1);
});

test("merged false remains visible to the agent", async () => {
  githubApi(() => Response.json({ ...merged, merged: false, message: "Not merged" }));
  assert.deepEqual(await mergeReviewedPullRequest.execute(input, ctx), {
    ...merged,
    merged: false,
    message: "Not merged",
  });
});

test("the input boundary requires a full reviewed SHA and a positive integer PR number", () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  const schema = mergeReviewedPullRequest.inputSchema;
  assert.ok(schema instanceof z.ZodObject);
  const { reviewedHeadSha, ...withoutSha } = input;
  assert.ok(schema.safeParse(input).success);
  assert.ok(schema.safeParse({ ...input, reviewedHeadSha: reviewedHeadSha.toUpperCase() }).success);

  for (const invalid of [
    withoutSha,
    ...["", "abc1234", "g".repeat(40), "a".repeat(41)].map((sha) => ({
      ...input,
      reviewedHeadSha: sha,
    })),
    ...[0, -1, 1.5].map((pullNumber) => ({ ...input, pullNumber })),
  ]) {
    assert.ok(!schema.safeParse(invalid).success);
  }

  assert.strictEqual(fetch.mock.calls.length, 0);
});

test("the merge tool rejects a missing installation before contacting GitHub", async () => {
  vi.spyOn(githubInstallation, "get").mockReturnValue(null);
  const fetch = vi.spyOn(globalThis, "fetch");
  await assert.rejects(
    Promise.resolve(mergeReviewedPullRequest.execute(input, ctx)),
    /installation is required/,
  );
  assert.strictEqual(fetch.mock.calls.length, 0);
});

test("owner and repository are escaped as independent path segments", async () => {
  const calls = githubApi(() => Response.json(merged));
  await mergeReviewedPullRequest.execute({ ...input, owner: "acme/other", repo: "app?query" }, ctx);
  assert.strictEqual(calls[1]?.url.pathname, "/repos/acme%2Fother/app%3Fquery/pulls/42/merge");
});
