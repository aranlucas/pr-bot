import { generateKeyPairSync } from "node:crypto";
import { assert, test, vi } from "vitest";
import githubExtension from "@github-tools/eve-extension";
import { github } from "@github-tools/eve-extension/tools";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import githubMount from "../agent/extensions/github.js";
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
  toolName: "github__addPullRequestComment",
  messages: [],
};

test("the mounted extension resolves native review tools and posts and merges through the GitHub App", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  vi.stubEnv("GITHUB_APP_ID", "123");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey.export({ type: "pkcs8", format: "pem" }));
  vi.spyOn(githubInstallation, "get").mockReturnValue(99);

  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const authorization = new Headers(init?.headers).get("authorization");

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

    if (path === "/repos/acme/app/issues/42/comments") {
      assert.deepEqual(JSON.parse(z.string().parse(init?.body)), {
        body: "No concrete defects found.",
      });

      return Promise.resolve(
        Response.json({
          id: 1,
          body: "No concrete defects found.",
          user: { login: "pr-bot[bot]" },
        }),
      );
    }

    if (path === "/repos/acme/app/pulls/42/merge") {
      assert.strictEqual(
        z.object({ merge_method: z.string() }).parse(JSON.parse(z.string().parse(init?.body)))
          .merge_method,
        "squash",
      );

      return Promise.resolve(Response.json({ merged: true, sha: "merged", message: "Merged" }));
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
  assert.ok(tools.mergePullRequest);

  const input = { owner: "acme", repo: "app", pullNumber: 42 };

  const comment = await tools.addPullRequestComment.execute(
    { ...input, body: "No concrete defects found." },
    ctx,
  );

  assert.strictEqual(z.object({ id: z.number() }).parse(comment).id, 1);

  const merge = await tools.mergePullRequest.execute(
    { ...input, mergeMethod: "squash" },
    { ...ctx, toolName: "github__mergePullRequest" },
  );

  assert.strictEqual(z.object({ merged: z.boolean() }).parse(merge).merged, true);
  assert.ok(calls.includes("POST /repos/acme/app/issues/42/comments"));
  assert.ok(calls.includes("PUT /repos/acme/app/pulls/42/merge"));
});
