import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";

const invocation = z.object({
  authenticator: z.literal("github-webhook"),
  attributes: z.object({ repository: z.string().regex(/^[^/]+\/[^/]+$/) }),
});
const repository = z.object({ owner: z.string().min(1), repo: z.string().min(1) });

export function approveRepositoryWrite(ctx: ApprovalContext): ApprovalStatus {
  const signed = invocation.safeParse(ctx.session.auth.current);
  const input = repository.safeParse(ctx.toolInput);
  if (
    !signed.success ||
    !input.success ||
    `${input.data.owner}/${input.data.repo}`.toLowerCase() !==
      signed.data.attributes.repository.toLowerCase()
  ) {
    return { type: "denied", reason: "Write blocked: target the signed webhook's repository." };
  }
  return "not-applicable";
}
