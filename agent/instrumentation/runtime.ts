import {
  defineInstrumentation,
  type InstrumentationEvent,
  type ProviderContext,
} from "eve/instrumentation";
import { z } from "zod";

const operationState = z.object({ startedAtMs: z.number(), tool: z.string().optional() });

function eventDetails(event: InstrumentationEvent, ctx: ProviderContext) {
  const started = operationState.safeParse(ctx.state.get()).data;
  const durationMs = started ? Date.now() - started.startedAtMs : undefined;

  switch (event.type) {
    case "session.started":
      return { channel: event.channelKind, traceId: event.traceSeed?.traceId };
    case "channel.delivery.started":
    case "channel.delivery.completed":
    case "channel.delivery.cancelled":
    case "channel.delivery.failed":
      return {
        channel: event.delivery.channelKind,
        deliveryId: event.delivery.deliveryId,
        requestId: event.delivery.requestId,
        ...("outcome" in event && { outcome: event.outcome, errorCode: event.errorCode }),
      };
    case "model.call.started":
      ctx.state.set({ startedAtMs: Date.now() });

      return { model: event.model.modelId, provider: event.model.provider };
    case "model.call.completed":
      return {
        durationMs,
        finishReason: event.finishReason,
        usage: {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cacheReadTokens: event.usage.inputTokenDetails?.cacheReadTokens,
          cacheWriteTokens: event.usage.inputTokenDetails?.cacheWriteTokens,
          costUsd: event.usage.costUsd,
        },
      };
    case "tool.call.started":
      ctx.state.set({ startedAtMs: event.startedAtMs ?? Date.now(), tool: event.toolName });

      return { tool: event.toolName, callId: event.callId, kind: event.kind };
    case "tool.call.completed":
      return {
        tool: started?.tool,
        durationMs: event.durationMs ?? durationMs,
        outcome: event.outcome,
        resultType: event.output.type,
      };
    case "tool.call.failed":
      return {
        tool: started?.tool,
        durationMs,
        outcome: event.outcome,
        errorCode: event.errorCode,
      };
    case "model.call.failed":
      return { durationMs };
    case "input.requested":
    case "input.resolved":
      return {
        inputKind: event.kind,
        requestId: event.requestId,
        ...("outcome" in event && { outcome: event.outcome }),
      };
    case "session.waiting":
    case "session.completed":
    case "session.failed":
    case "turn.started":
    case "turn.completed":
    case "turn.cancelled":
    case "turn.failed":
    case "step.attempt.started":
    case "step.attempt.completed":
    case "step.attempt.failed":
    case "step.attempt.metadata":
    case "memory.operation.started":
    case "memory.operation.completed":
    case "memory.operation.failed":
      return {};
  }
}

function logEvent(event: InstrumentationEvent, ctx: ProviderContext): void {
  const record = {
    source: "pr-bot.runtime",
    event: event.type,
    operationId: event.idempotencyKey,
    ...("scope" in event
      ? {
          sessionId: event.scope.sessionId,
          turnId: event.scope.turnId,
          stepIndex: event.scope.stepIndex,
          attemptIndex: event.scope.attemptIndex,
        }
      : { sessionId: event.sessionId, ...("turnId" in event && { turnId: event.turnId }) }),
  };

  const details = eventDetails(event, ctx);
  const line = JSON.stringify({ ...record, ...details });

  if (
    event.type.endsWith(".failed") ||
    (event.type === "tool.call.completed" && event.output.type === "error")
  ) {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export default defineInstrumentation({
  tracePolicy: () => ({ emit: true, recordInputs: false, recordOutputs: false }),
  events: {
    "session.started": logEvent,
    "session.waiting": logEvent,
    "session.completed": logEvent,
    "session.failed": logEvent,
    "turn.started": logEvent,
    "turn.completed": logEvent,
    "turn.cancelled": logEvent,
    "turn.failed": logEvent,
    "channel.delivery.started": logEvent,
    "channel.delivery.completed": logEvent,
    "channel.delivery.cancelled": logEvent,
    "channel.delivery.failed": logEvent,
    "step.attempt.started": logEvent,
    "step.attempt.completed": logEvent,
    "step.attempt.failed": logEvent,
    "model.call.started": logEvent,
    "model.call.completed": logEvent,
    "model.call.failed": logEvent,
    "tool.call.started": logEvent,
    "tool.call.completed": logEvent,
    "tool.call.failed": logEvent,
    "input.requested": logEvent,
    "input.resolved": logEvent,
  },
});
