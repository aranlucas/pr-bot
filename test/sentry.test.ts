import { assert, test } from "vitest";
import { buildFailureEvent } from "../agent/lib/sentry.js";

const modelFailure = {
  source: "pr-bot.runtime",
  event: "model.call.failed",
  operationId: "session-1:turn-1:3:0:model:0",
  sessionId: "session-1",
  turnId: "turn-1",
  stepIndex: 3,
  attemptIndex: 0,
  durationMs: 90_000,
  errorCode: "model_stream_stalled",
};

test("failure events carry only runtime metadata", () => {
  const withContent = {
    ...modelFailure,
    model: "auto",
    input: { messages: ["secret prompt"] },
    error: { message: "secret provider response" },
  };

  const event = buildFailureEvent(withContent);

  assert.ok(event);
  assert.strictEqual(event.type, undefined);
  assert.strictEqual(event.level, "error");
  assert.strictEqual(event.message, "PR Bot model.call.failed");
  assert.deepEqual(event.fingerprint, [
    "pr-bot",
    "model.call.failed",
    "none",
    "model_stream_stalled",
  ]);
  assert.deepEqual(event.tags, {
    lifecycle: "model.call.failed",
    errorCode: "model_stream_stalled",
  });
  assert.deepEqual(event.contexts?.runtime, modelFailure);
  assert.notInclude(JSON.stringify(event), "secret");
});

test("unrelated records are not reported", () => {
  assert.isUndefined(buildFailureEvent({ ...modelFailure, source: "other" }));
  assert.isUndefined(buildFailureEvent({ ...modelFailure, sessionId: "" }));
});

test("cancelled and abandoned outcomes are not failures", () => {
  assert.isUndefined(
    buildFailureEvent({
      source: "pr-bot.runtime",
      event: "channel.delivery.failed",
      operationId: "session-1:delivery-1",
      sessionId: "session-1",
      outcome: "cancelled",
    }),
  );
  assert.isUndefined(buildFailureEvent({ ...modelFailure, outcome: "abandoned" }));
  assert.ok(
    buildFailureEvent({
      source: "pr-bot.runtime",
      event: "channel.delivery.failed",
      operationId: "session-1:delivery-1",
      sessionId: "session-1",
      outcome: "failed",
    }),
  );
});

test("reported failures are deduplicated by operation and event", () => {
  const first = buildFailureEvent(modelFailure);
  const second = buildFailureEvent({ ...modelFailure, durationMs: 120_000 });
  const other = buildFailureEvent({ ...modelFailure, operationId: "session-2:turn-1:3:0:model:0" });

  assert.ok(first && second && other);
  assert.strictEqual(first.event_id, second.event_id);
  assert.notStrictEqual(first.event_id, other.event_id);
  assert.match(first.event_id ?? "", /^[a-f0-9]{32}$/);
});

test("tool failures are warnings while failed turns and error-finished model calls are errors", () => {
  const tool = buildFailureEvent({
    source: "pr-bot.runtime",
    event: "tool.call.failed",
    operationId: "session-1:turn-1:3:0:tool:call-1",
    sessionId: "session-1",
    tool: "github__createPullRequestReview",
    errorCode: "permission_denied",
  });

  const turn = buildFailureEvent({
    source: "pr-bot.runtime",
    event: "turn.failed",
    operationId: "session-1:turn-1",
    sessionId: "session-1",
  });

  const stream = buildFailureEvent({
    source: "pr-bot.runtime",
    event: "model.call.completed",
    operationId: "session-1:turn-1:3:0:model:0",
    sessionId: "session-1",
    finishReason: "error",
  });

  assert.strictEqual(tool?.level, "warning");
  assert.deepEqual(tool?.fingerprint, [
    "pr-bot",
    "tool.call.failed",
    "github__createPullRequestReview",
    "permission_denied",
  ]);
  assert.strictEqual(turn?.level, "error");
  assert.strictEqual(stream?.level, "error");
});
