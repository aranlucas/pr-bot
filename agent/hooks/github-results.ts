import { GITHUB_TOOL_NAMES, githubToolsErrors } from "@github-tools/sdk/eve-runtime";
import { defineHook } from "eve/hooks";
import { z } from "zod";
import { reportRuntimeFailure } from "@/sentry";

const githubTool = z.enum(Object.values(GITHUB_TOOL_NAMES).map((name) => `github__${name}`));

const errorCode = z.enum([
  ...Object.keys(githubToolsErrors).map((code) => `github_tools.${code}`),
  "github_tools.UNKNOWN",
]);

const returnedError = z.object({
  error: z.union([
    z.string().transform(() => ({ code: "github_tools.UNKNOWN" })),
    z.object({ code: errorCode.catch("github_tools.UNKNOWN").default("github_tools.UNKNOWN") }),
  ]),
});

export default defineHook({
  events: {
    "action.result"(event, ctx) {
      const { result, status, turnId, stepIndex } = event.data;

      if (status !== "completed" || result.kind !== "tool-result" || result.isError) {
        return;
      }

      const tool = githubTool.safeParse(result.toolName);
      const failed = returnedError.safeParse(result.output);

      if (!tool.success || !failed.success) {
        return;
      }

      reportRuntimeFailure({
        source: "pr-bot.runtime",
        event: "tool.result.failed",
        operationId: `tool-result:${ctx.session.id}:${turnId}:${result.callId}`,
        sessionId: ctx.session.id,
        turnId,
        stepIndex,
        callId: result.callId,
        tool: tool.data,
        errorCode: failed.data.error.code,
        outcome: "failed",
        resultType: "error",
      });
    },
  },
});
