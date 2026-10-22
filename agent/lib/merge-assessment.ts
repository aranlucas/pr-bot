import { defineState, type SessionContext } from "eve/context";
import { z } from "zod";

export const botName = "aranlucas-pr-bot";

export const pausedLabel = "pr-bot:paused";

export const mergePolicyVersion = 1;

export const assessmentInput = z.object({
  headSha: z.string().min(1),
  coverage: z.enum(["complete", "incomplete"]),
  unresolvedFindings: z.boolean(),
  reversibility: z.enum(["reversible", "irreversible", "uncertain"]),
  blastRadius: z.enum(["localized", "broad", "uncertain"]),
  verification: z.enum(["sufficient", "missing"]),
  reviewOnly: z.boolean(),
  rationale: z.string().trim().min(1).max(2000),
});

type Assessment = z.infer<typeof assessmentInput>;

interface PullRequestTarget {
  owner: string;
  repo: string;
  pullNumber: number;
}

const invocation = z.object({
  authenticator: z.literal("github-webhook"),
  attributes: z.object({
    conversation_kind: z.enum(["pull_request", "review_thread"]),
    repository: z.string().regex(/^[^/]+\/[^/]+$/),
    pull_request_number: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().positive()),
  }),
});

export function currentPullRequest(ctx: SessionContext): PullRequestTarget | undefined {
  const parsed = invocation.safeParse(ctx.session.auth.current);

  if (!parsed.success) {
    return;
  }

  const [owner, repo] = parsed.data.attributes.repository.split("/");

  return { owner, repo, pullNumber: parsed.data.attributes.pull_request_number };
}

export function samePullRequest(a: PullRequestTarget, b: PullRequestTarget): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase() &&
    a.pullNumber === b.pullNumber
  );
}

function decision(assessment: Assessment) {
  const reasons: string[] = [];

  if (assessment.reviewOnly) {
    reasons.push("review_only");
  }

  if (assessment.unresolvedFindings) {
    reasons.push("unresolved_findings");
  }

  if (assessment.reversibility !== "reversible") {
    reasons.push(assessment.reversibility);
  }

  if (assessment.blastRadius !== "localized") {
    reasons.push(`blast_radius_${assessment.blastRadius}`);
  }

  const needsHuman = reasons.length > 0;

  if (assessment.coverage !== "complete") {
    reasons.push("incomplete_coverage");
  }

  if (assessment.verification !== "sufficient") {
    reasons.push("missing_verification");
  }

  const status = needsHuman
    ? "human_review_required"
    : reasons.length > 0
      ? "waiting_for_evidence"
      : "eligible";

  return { status, reasons };
}

interface RecordedAssessment {
  policyVersion: number;
  turnId: string;
  target: PullRequestTarget;
  assessment: Assessment;
  status: string;
}

export const mergeAssessment = defineState<RecordedAssessment | null>(
  "pr-bot.merge-assessment",
  () => null,
);

export function recordMergeAssessment(input: Assessment, ctx: SessionContext) {
  const target = currentPullRequest(ctx);

  if (!target) {
    throw new Error("A signed GitHub pull-request invocation is required.");
  }

  const result = decision(input);
  mergeAssessment.update(() => ({
    policyVersion: mergePolicyVersion,
    turnId: ctx.session.turn.id,
    target,
    assessment: input,
    status: result.status,
  }));

  return { policyVersion: mergePolicyVersion, ...target, ...input, ...result };
}
