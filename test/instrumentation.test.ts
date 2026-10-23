import { assert, afterEach, test, vi } from "vitest";
import type { JsonValue, ProviderContext } from "eve/instrumentation";
import instrumentation from "../agent/instrumentation/runtime.js";

const scope = {
  sessionId: "review-session",
  turnId: "turn-1",
  stepIndex: 3,
  attemptIndex: 0,
  attemptId: "attempt-3",
};

function context(initial?: JsonValue): ProviderContext {
  let value = initial;

  return {
    state: {
      get: () => value,
      set: (next) => {
        value = next;
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

test("model calls report latency and usage without logging prompt or response content", async () => {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const ctx = context();

  vi.useFakeTimers();
  vi.setSystemTime(1_000);

  await instrumentation.events?.["model.call.started"]?.(
    {
      type: "model.call.started",
      idempotencyKey: "model-3",
      scope,
      model: { modelId: "auto", provider: "freellmapi" },
      input: { messages: ["secret prompt"] },
    },
    ctx,
  );

  vi.setSystemTime(76_000);

  await instrumentation.events?.["model.call.completed"]?.(
    {
      type: "model.call.completed",
      idempotencyKey: "model-3",
      scope,
      finishReason: "tool-calls",
      responseModelId: "served-model",
      responseId: "provider-response-1",
      usage: { inputTokens: 20_000, outputTokens: 200 },
      content: [{ type: "text", text: "secret response" }],
    },
    context(ctx.state.get()),
  );

  assert.strictEqual(output.mock.calls.length, 2);
  const lines = output.mock.calls.map(([line]) => String(line));

  assert.include(lines[0], '"model":"auto"');
  assert.include(lines[1], '"sessionId":"review-session"');
  assert.include(lines[1], '"operationId":"model-3"');
  assert.include(lines[1], '"durationMs":75000');
  assert.include(lines[1], '"finishReason":"tool-calls"');
  assert.include(lines[1], '"inputTokens":20000');
  assert.include(lines[1], '"responseModelId":"served-model"');
  assert.include(lines[1], '"responseId":"provider-response-1"');
  assert.notInclude(lines.join(""), "secret");
});

test("a completed stream with an error finish reason is logged as a failure", async () => {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  await instrumentation.events?.["model.call.completed"]?.(
    {
      type: "model.call.completed",
      idempotencyKey: "failed-stream",
      scope,
      finishReason: "error",
      usage: {},
      content: [{ type: "text", text: "secret partial response" }],
    },
    context(),
  );

  assert.strictEqual(errors.mock.calls.length, 1);
  assert.strictEqual(output.mock.calls.length, 0);
  const line = String(errors.mock.calls[0][0]);

  assert.include(line, '"finishReason":"error"');
  assert.include(line, '"sessionId":"review-session"');
  assert.notInclude(line, "secret");
});

test("failed model attempts retain model identity after worker replacement without error content", async () => {
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const ctx = context();

  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  await instrumentation.events?.["model.call.started"]?.(
    {
      type: "model.call.started",
      idempotencyKey: "failed-model",
      scope,
      model: { modelId: "auto", provider: "freellmapi.chat" },
    },
    ctx,
  );

  vi.setSystemTime(91_000);
  await instrumentation.events?.["model.call.failed"]?.(
    {
      type: "model.call.failed",
      idempotencyKey: "failed-model",
      scope,
      error: new Error("secret upstream headers"),
    },
    context(ctx.state.get()),
  );

  const line = String(errors.mock.calls[0][0]);
  assert.include(line, '"model":"auto"');
  assert.include(line, '"provider":"freellmapi.chat"');
  assert.include(line, '"durationMs":90000');
  assert.include(line, '"level":"warning"');
  assert.include(line, '"failureKind":"attempt_failure"');
  assert.notInclude(line, "secret");
});

test("tool identity survives worker replacement and errors produce metadata-only error logs", async () => {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const ctx = context();

  vi.useFakeTimers();
  vi.setSystemTime(1_000);

  await instrumentation.events?.["tool.call.started"]?.(
    {
      type: "tool.call.started",
      idempotencyKey: "tool-4",
      callId: "call-4",
      scope,
      toolName: "github__createPullRequestReview",
      input: { body: "secret review", token: "secret token" },
    },
    ctx,
  );

  vi.setSystemTime(4_000);

  await instrumentation.events?.["tool.call.failed"]?.(
    {
      type: "tool.call.failed",
      idempotencyKey: "tool-4",
      scope,
      outcome: "failed",
      errorCode: "permission_denied",
      error: new Error("secret token from upstream"),
    },
    context(ctx.state.get()),
  );

  assert.strictEqual(errors.mock.calls.length, 1);
  const line = String(errors.mock.calls[0][0]);

  assert.include(line, '"tool":"github__createPullRequestReview"');
  assert.include(line, '"durationMs":3000');
  assert.include(line, '"errorCode":"permission_denied"');
  assert.notInclude(line + String(output.mock.calls[0][0]), "secret");
});

test("returned tool errors are visible even when Eve completes the call", async () => {
  const errors = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  await instrumentation.events?.["tool.call.completed"]?.(
    {
      type: "tool.call.completed",
      idempotencyKey: "tool-5",
      scope,
      durationMs: 500,
      output: { type: "error", error: "secret upstream response" },
    },
    context(),
  );

  assert.strictEqual(errors.mock.calls.length, 1);
  const line = String(errors.mock.calls[0][0]);

  assert.include(line, '"resultType":"error"');
  assert.include(line, '"durationMs":500');
  assert.notInclude(line, "secret");
});

test("waiting and session limits are distinguishable without exposing questions", async () => {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  await instrumentation.events?.["input.requested"]?.(
    {
      type: "input.requested",
      idempotencyKey: "input-1",
      scope,
      kind: "session-limit",
      action: { callId: "call-6", name: "continue" },
      requestId: "request-1",
      request: { prompt: "secret question" },
    },
    context(),
  );

  await instrumentation.events?.["session.waiting"]?.(
    {
      type: "session.waiting",
      idempotencyKey: "session-1",
      sessionId: scope.sessionId,
    },
    context(),
  );

  assert.strictEqual(output.mock.calls.length, 2);
  const lines = output.mock.calls.map(([line]) => String(line)).join("");

  assert.include(lines, '"inputKind":"session-limit"');
  assert.include(lines, '"event":"session.waiting"');
  assert.notInclude(lines, "secret");
});

test("runtime log policy excludes content for every audience", () => {
  for (const audience of ["public", "private", "unknown"] as const) {
    assert.deepEqual(
      instrumentation.tracePolicy?.({
        agentName: "pr-bot",
        audience,
        channel: { kind: "channel:github" },
        environment: "production",
        principalType: "app",
      }),
      { emit: true, recordInputs: false, recordOutputs: false },
    );
  }
});
