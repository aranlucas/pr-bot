import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { config, repositoryAllowed, type Config } from "@/config";
import { createGitHub, type GitHub, type Snapshot, type Target } from "@/github";
import { createStore, type Store } from "@/store";

export const commentSchema = z.object({
  reviewId: z.string().length(64),
  body: z.string().trim().min(1).max(20_000),
});

export interface ReviewDependencies {
  readonly github: Readonly<GitHub>;
  readonly store: Readonly<Store>;
  readonly policy: Config;
}

export function blockers(pr: Snapshot, policy: Config): string[] {
  const reasons: string[] = [];
  const allowedBranch = policy.baseBranch === "default" ? pr.defaultBranch : policy.baseBranch;

  if (pr.state !== "open" || pr.merged) {
    reasons.push("PR is not open");
  }

  if (pr.draft) {
    reasons.push("PR is a draft");
  }

  if (pr.baseBranch !== allowedBranch) {
    reasons.push("Base branch is not allowed");
  }

  if (pr.mergeable !== true || pr.mergeableState !== "clean") {
    reasons.push("GitHub merge state is not clean");
  }

  if (pr.approvals.length < policy.minApprovals) {
    reasons.push("Not enough current-commit approvals from collaborators");
  }

  if (pr.changesRequested) {
    reasons.push("A reviewer has requested changes");
  }

  if (pr.checks.length === 0) {
    reasons.push("No CI checks are present");
  }

  if (pr.checks.some((check) => !check.success)) {
    reasons.push("A check is pending or unsuccessful");
  }

  for (const name of policy.requiredChecks) {
    if (!pr.checks.some((check) => check.name === name && check.success)) {
      reasons.push(`Missing successful required check: ${name}`);
    }
  }

  if (!pr.completeDiff || pr.files.length === 0) {
    reasons.push("Diff is incomplete, binary, empty, or too large");
  }

  return reasons;
}

interface WebhookPrincipal {
  readonly authenticator?: string;
  readonly principalType?: string;
  readonly attributes?: unknown;
}

export function verifiedTarget(caller: WebhookPrincipal | null | undefined): Target {
  if (caller?.authenticator !== "github-app" || caller.principalType !== "service") {
    throw new Error("Verified webhook principal required");
  }

  return z
    .object({
      repository: z.string(),
      number: z.coerce.number().int().positive(),
      delivery: z.string().min(1),
      installationId: z.coerce.number().int().positive(),
    })
    .parse(caller.attributes);
}

function dependencies(target: Target): ReviewDependencies {
  return {
    github: createGitHub({ installationId: target.installationId }),
    store: createStore(),
    policy: config(),
  };
}

function assertAllowed(target: Target, policy: Config) {
  if (!repositoryAllowed(target.repository, policy)) {
    throw new Error("Repository is not allowed");
  }
}

const reviewKey = (target: Target) =>
  `pr-bot:context:${target.repository}:${target.number}:${target.delivery}`;

function reviewData(pr: Snapshot) {
  return {
    head: pr.head,
    base: pr.base,
    title: pr.title.slice(0, 1000),
    body: pr.body.slice(0, 16000),
    completeDiff: pr.completeDiff && pr.files.length > 0,
    files: pr.completeDiff ? pr.files : [],
  };
}

const fingerprint = (pr: Snapshot) =>
  createHash("sha256")
    .update(JSON.stringify(reviewData(pr)))
    .digest("hex");

export async function prepareReview(target: Target, deps = dependencies(target)) {
  assertAllowed(target, deps.policy);
  const pr = await deps.github.snapshot(target);
  const reviewId = fingerprint(pr);
  await deps.store.set(reviewKey(target), reviewId, 7 * 24 * 60 * 60);

  return {
    reviewId,
    repository: target.repository,
    number: target.number,
    state: pr.state,
    merged: pr.merged,
    draft: pr.draft,
    ...reviewData(pr),
  };
}

export async function postComment(
  target: Target,
  input: z.infer<typeof commentSchema>,
  deps = dependencies(target),
) {
  assertAllowed(target, deps.policy);
  const { reviewId, body } = commentSchema.parse(input);
  const { github, store } = deps;
  const lockKey = `pr-bot:lock:${target.repository}:${target.number}`;
  const token = randomUUID();

  if (!(await store.claim(lockKey, token, 120))) {
    throw new Error("PR comment already being posted; retry");
  }

  try {
    if ((await store.get<string>(reviewKey(target))) !== reviewId) {
      throw new Error("Review context is missing or does not match this delivery");
    }

    const pr = await github.snapshot(target);

    if (pr.state !== "open" || pr.merged) {
      return { outcome: "skipped", reason: "PR is no longer open" };
    }

    if (fingerprint(pr) !== reviewId) {
      throw new Error("PR changed during review; a fresh webhook review is required");
    }

    if ((await store.get<string>(lockKey)) !== token) {
      throw new Error("PR comment lock expired");
    }

    await github.postComment(target, pr.head, body);
    await store.set(`${reviewKey(target)}:posted`, { reviewId, body }, 7 * 24 * 60 * 60);

    return { outcome: "commented", head: pr.head };
  } finally {
    await store.release(lockKey, token);
  }
}

const postedReviewSchema = z.object({ reviewId: z.string().length(64), body: z.string() });

export async function mergePullRequest(target: Target, deps = dependencies(target)) {
  assertAllowed(target, deps.policy);
  const { github, store, policy } = deps;
  const lockKey = `pr-bot:lock:${target.repository}:${target.number}`;
  const token = randomUUID();

  if (!(await store.claim(lockKey, token, 120))) {
    throw new Error("PR operation already running; retry");
  }

  try {
    const posted = postedReviewSchema.safeParse(await store.get(`${reviewKey(target)}:posted`));

    if (!posted.success) {
      throw new Error("post-comment must succeed for this delivery before merging");
    }

    const pr = await github.snapshot(target);

    if (fingerprint(pr) !== posted.data.reviewId) {
      throw new Error("PR changed since the posted review; a fresh review is required");
    }

    const reasons = blockers(pr, policy);

    if (reasons.length) {
      return { outcome: "held", reason: reasons.join("; "), head: pr.head };
    }

    if (policy.dryRun) {
      return { outcome: "dry-run", head: pr.head };
    }

    const checkLease = async () => {
      if ((await store.get<string>(lockKey)) !== token) {
        throw new Error("PR operation lock expired");
      }
    };

    await checkLease();

    const result = await github.merge(
      target,
      pr.head,
      policy.mergeMethod,
      posted.data.body,
      checkLease,
    );

    return { outcome: result.merged ? "merged" : "held", head: pr.head, reason: result.message };
  } finally {
    await store.release(lockKey, token);
  }
}
