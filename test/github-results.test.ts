import { assert, test, vi } from "vitest";
import { executeGithubEveTool } from "@github-tools/sdk/eve-runtime";
import type { HookContext, HookEvent } from "eve/hooks";
import { z } from "zod";
import githubResults from "../agent/hooks/github-results.js";
import { buildFailureEvent } from "../agent/lib/sentry.js";
import failedTurns from "../agent/hooks/failed-turns.js";

function unexpected(): never {
  throw new Error("Unexpected fixture operation");
}

const ctx: HookContext = {
  agent: { name: "pr-bot" },
  channel: { kind: "channel:github" },
  session: {
    id: "session",
    turn: { id: "turn", sequence: 0 },
    auth: { current: null, initiator: null },
  },
  getSandbox: unexpected,
  cancel: unexpected,
};

function event(
  output: HookEvent<"action.result">["data"]["result"]["output"],
): HookEvent<"action.result"> {
  return {
    type: "action.result",
    meta: { id: "event-1", at: "2026-10-23T17:00:00Z" },
    data: {
      sequence: 0,
      stepIndex: 3,
      turnId: "turn",
      status: "completed",
      result: {
        kind: "tool-result",
        callId: "call-1",
        toolName: "github__createPullRequestReview",
        output,
      },
    },
  };
}

test.each([
  [401, "UNAUTHORIZED"],
  [403, "FORBIDDEN"],
  [404, "NOT_FOUND"],
  [422, "VALIDATION_FAILED"],
])(
  "GitHub HTTP %i returned as a resolved result is reported without upstream content",
  async (status, code) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ message: "secret upstream body" }, { status }),
    );
    const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const output = await executeGithubEveTool(
      "createPullRequestReview",
      { owner: "acme", repo: "app", pullNumber: 42, body: "secret review", event: "COMMENT" },
      { token: "secret installation token" },
    );

    const parsed = z.object({ error: z.object({ code: z.string() }) }).parse(output);
    assert.strictEqual(parsed.error.code, `github_tools.${code}`);

    // Pass the real executor's JSON result through Eve's public stream-hook boundary.
    await githubResults.events?.["action.result"]?.(event(z.json().parse(output)), ctx);

    const line = String(errors.mock.calls[0][0]);
    assert.include(line, '"event":"tool.result.failed"');
    assert.include(line, `"errorCode":"github_tools.${code}"`);
    assert.include(line, '"tool":"github__createPullRequestReview"');
    assert.include(line, '"sessionId":"session"');
    assert.notInclude(line, "secret");
  },
);

test.each([
  {
    output: { error: { code: "github_tools.RATE_LIMITED", message: "secret rate details" } },
    code: "github_tools.RATE_LIMITED",
  },
  {
    output: { error: { code: "secret unknown code", message: "secret details" } },
    code: "github_tools.UNKNOWN",
  },
  { output: { error: "secret unmapped error" }, code: "github_tools.UNKNOWN" },
])(
  "returned error codes are allowlisted and replay uses the same failure identity",
  async ({ output, code }) => {
    const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const original = event(output);
    await githubResults.events?.["action.result"]?.(original, ctx);
    await githubResults.events?.["action.result"]?.(
      { ...original, meta: { ...original.meta, id: "replayed-event" } },
      ctx,
    );

    const schema = z.object({
      source: z.string(),
      event: z.string(),
      operationId: z.string(),
      sessionId: z.string(),
      errorCode: z.string(),
    });

    const records = errors.mock.calls.map(([line]) => schema.parse(JSON.parse(String(line))));
    assert.lengthOf(records, 2);
    assert.strictEqual(records[0].errorCode, code);
    assert.strictEqual(
      buildFailureEvent(records[0])?.event_id,
      buildFailureEvent(records[1])?.event_id,
    );
    assert.notInclude(JSON.stringify(errors.mock.calls), "secret");
  },
);

test("successful, unrelated, and already-failed actions do not produce duplicate failure reports", async () => {
  const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  await githubResults.events?.["action.result"]?.(event({ id: 42 }), ctx);
  const failed = event({ error: { code: "github_tools.NOT_FOUND" } });
  await githubResults.events?.["action.result"]?.(
    { ...failed, data: { ...failed.data, status: "failed" } },
    ctx,
  );
  const unrelated = event({ error: { code: "github_tools.NOT_FOUND" } });

  if (unrelated.data.result.kind === "tool-result") {
    unrelated.data.result.toolName = "another__createPullRequestReview";
  }

  await githubResults.events?.["action.result"]?.(unrelated, ctx);
  assert.strictEqual(errors.mock.calls.length, 0);
});

test.each([true, false])(
  "failed turns retain their code and terminal=%s without content",
  async (terminal) => {
    const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await failedTurns.events?.["turn.failed"]?.(
      {
        type: "turn.failed",
        meta: { id: "turn-failed", at: "2026-10-23T17:00:00Z" },
        data: {
          code: "MODEL_CALL_FAILED",
          terminal,
          message: "secret error text",
          turnId: "turn",
          sequence: 1,
          details: { secret: "secret details" },
        },
      },
      ctx,
    );

    const line = String(errors.mock.calls[0][0]);
    assert.include(line, '"errorCode":"MODEL_CALL_FAILED"');
    assert.include(line, `"terminal":${String(terminal)}`);
    assert.include(line, '"level":"error"');
    assert.notInclude(line, "secret");
  },
);
