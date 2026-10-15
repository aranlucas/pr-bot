import { defineTool } from "eve/tools";
import { z } from "zod";
import { reviewPullRequest } from "@/review";

export default defineTool({
  description:
    "Review and conditionally merge the PR identified by the verified webhook. Policy and independent OpenRouter review are enforced inside this tool.",
  inputSchema: z.object({}),
  availableInSubagents: false,
  execute(_input, ctx) {
    const caller = ctx.session.auth.current;

    if (caller?.authenticator !== "github-app" || caller.principalType !== "service") {
      throw new Error("Verified webhook principal required");
    }

    const target = z
      .object({
        repository: z.string(),
        number: z.coerce.number().int().positive(),
        delivery: z.string(),
        installationId: z.coerce.number().int().positive(),
      })
      .parse(caller.attributes);

    return reviewPullRequest(target);
  },
  endsTurn: true,
});
