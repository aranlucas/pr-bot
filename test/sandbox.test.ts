import { assert, beforeEach, expect, test, vi } from "vitest";
import type { GitHubEventContext } from "eve/channels/github";
import type { HookContext } from "eve/hooks";

function unexpected(): never {
  throw new Error("Unexpected fixture operation");
}

function runtimeContext() {
  const stop = vi.fn<() => Promise<void>>().mockResolvedValue();

  const ctx: HookContext = {
    agent: { name: "pr-bot" },
    channel: { kind: "github" },
    cancel: unexpected,
    session: {
      id: "session",
      auth: { current: null, initiator: null },
      turn: { id: "turn", sequence: 1 },
    },
    getSandbox: unexpected,
  };

  const getSandbox = vi.spyOn(ctx, "getSandbox").mockResolvedValue({
    run: unexpected,
    spawn: unexpected,
    readFile: unexpected,
    readBinaryFile: unexpected,
    readTextFile: unexpected,
    writeFile: unexpected,
    writeBinaryFile: unexpected,
    writeTextFile: unexpected,
    resolvePath: unexpected,
    removePath: unexpected,
    delete: unexpected,
    stop,
  });

  return { ctx, getSandbox, stop };
}

function githubContext(react: GitHubEventContext["thread"]["react"]): GitHubEventContext {
  const repository = { id: 123, fullName: "Acme/App", name: "App", owner: "Acme", private: false };

  return {
    conversation: { kind: "pull_request", issueNumber: 7, pullRequestNumber: 7 },
    repository,
    github: { installationId: 99, repository, request: unexpected },
    thread: { kind: "pull_request", post: unexpected, react },
    state: {
      baseRef: null,
      baseSha: null,
      checkoutPath: null,
      conversationKind: "pull_request",
      defaultBranch: null,
      headRef: null,
      headSha: "head",
      installationId: 99,
      issueNumber: 7,
      owner: "Acme",
      pullRequestNumber: 7,
      repo: "App",
      repositoryId: 123,
      reviewCommentId: null,
      reviewThreadRootCommentId: null,
      triggeringCommentId: null,
      triggeringUserLogin: null,
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("SANDBOX_ENABLED", "");
});

test.each([
  { value: undefined, enabled: false },
  { value: "", enabled: false },
  { value: "false", enabled: false },
  { value: "true", enabled: true },
])("sandbox configuration for SANDBOX_ENABLED=$value", async ({ value, enabled }) => {
  vi.stubEnv("SANDBOX_ENABLED", value);

  const { env } = await import("../agent/lib/env.js");
  const { default: agent } = await import("../agent/agent.js");
  const { githubEvents } = await import("../agent/channels/github.js");

  assert.strictEqual(env.SANDBOX_ENABLED, enabled);
  assert.strictEqual(agent.defaultTools, enabled);
  // Omitting the override preserves Eve's native checkout when enabled.
  assert.strictEqual("turn.started" in githubEvents, !enabled);
});

test.each(["false", "true"])(
  "skipping validation cannot enable sandbox from a raw %s string",
  async (value) => {
    vi.stubEnv("SKIP_ENV_VALIDATION", "1");
    vi.stubEnv("SANDBOX_ENABLED", value);
    vi.stubEnv("FREELLM_MODEL", "auto");

    const { default: agent } = await import("../agent/agent.js");
    const { githubEvents } = await import("../agent/channels/github.js");
    const { default: hook } = await import("../agent/hooks/release-sandbox.js");
    const { ctx, getSandbox } = runtimeContext();

    assert.strictEqual(agent.defaultTools, false);
    assert.isFunction(githubEvents["turn.started"]);

    await hook.events?.["session.waiting"]?.(
      {
        type: "session.waiting",
        data: { continuationToken: "session", wait: "next-user-message" },
        meta: { id: "waiting", at: "2026-10-20T12:00:00.000Z" },
      },
      ctx,
    );

    assert.strictEqual(getSandbox.mock.calls.length, 0);
  },
);

test.each(["1", "0", "yes", "FALSE", "invalid"])(
  "rejects ambiguous SANDBOX_ENABLED=%s",
  async (value) => {
    vi.stubEnv("SANDBOX_ENABLED", value);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(import("../agent/lib/env.js")).rejects.toThrow("Invalid environment variables");
  },
);

test.each([false, true])(
  "disabled sandbox acknowledges a review without compute (reaction fails: %s)",
  async (reactionFails) => {
    const react = vi.fn<GitHubEventContext["thread"]["react"]>();

    if (reactionFails) {
      react.mockRejectedValue(new Error("GitHub unavailable"));
    } else {
      react.mockResolvedValue();
    }

    const { githubEvents } = await import("../agent/channels/github.js");

    const start = githubEvents["turn.started"];
    assert.isDefined(start);
    const { ctx, getSandbox } = runtimeContext();
    const channel = githubContext(react);

    await start({ turnId: "turn", sequence: 1 }, channel, ctx);

    assert.deepEqual(react.mock.calls, [["eyes"]]);
    assert.strictEqual(getSandbox.mock.calls.length, 0);
    assert.strictEqual(channel.state.checkoutPath, null);
  },
);

test.each([
  { value: undefined, enabled: false },
  { value: "false", enabled: false },
  { value: "true", enabled: true },
])("idle cleanup with SANDBOX_ENABLED=$value", async ({ value, enabled }) => {
  vi.stubEnv("SANDBOX_ENABLED", value);
  const { default: hook } = await import("../agent/hooks/release-sandbox.js");
  const waiting = hook.events?.["session.waiting"];
  assert.isDefined(waiting);
  const { ctx, getSandbox, stop } = runtimeContext();

  await waiting(
    {
      type: "session.waiting",
      data: { continuationToken: "session", wait: "next-user-message" },
      meta: { id: "waiting", at: "2026-10-20T12:00:00.000Z" },
    },
    ctx,
  );

  assert.strictEqual(getSandbox.mock.calls.length, enabled ? 1 : 0);
  assert.strictEqual(stop.mock.calls.length, enabled ? 1 : 0);
});
