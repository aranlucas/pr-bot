import { defineHook } from "eve/hooks";
import { reportRuntimeFailure } from "@/sentry";

export default defineHook({
  events: {
    "turn.failed"(event, ctx) {
      reportRuntimeFailure({
        source: "pr-bot.runtime",
        event: "turn.failed",
        operationId: `turn:${ctx.session.id}:${event.data.turnId}`,
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
        errorCode: event.data.code,
        terminal: event.data.terminal,
      });
    },
  },
});
