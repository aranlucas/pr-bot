import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareReview, postComment, mergePullRequest, verifiedTarget } from "@/review";
import type { ReviewDependencies } from "@/review";
import type { Snapshot, Target } from "@/github";
import type { Store } from "@/store";

const target: Target = { repository: "acme/app", number: 42, installationId: 99, delivery: "one" };

const snapshot = (): Snapshot => ({
  head: "head-sha",
  base: "base-sha",
  baseBranch: "main",
  defaultBranch: "main",
  state: "open",
  draft: false,
  merged: false,
  mergeable: true,
  mergeableState: "clean",
  labels: ["agent:merge"],
  title: "Fix edge case",
  body: "",
  author: "author",
  checks: [{ name: "test", success: true }],
  approvals: ["reviewer"],
  changesRequested: false,
  completeDiff: true,
  files: [{ path: "src/app.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }],
});

function fixture() {
  const data = new Map<string, unknown>();
  let pr = snapshot();
  let failComment = false;
  const comments: string[] = [];
  const merges: string[] = [];

  const store: Store = {
    get<T>(key: string) {
      // SAFETY: Values are read with the same types as the production keys that wrote them.
      return Promise.resolve((data.get(key) as T) ?? null);
    },
    set(key, value) {
      data.set(key, value);

      return Promise.resolve();
    },
    claim(key, token) {
      if (data.has(key)) {
        return Promise.resolve(false);
      }

      data.set(key, token);

      return Promise.resolve(true);
    },
    release(key, token) {
      if (data.get(key) === token) {
        data.delete(key);
      }

      return Promise.resolve();
    },
  };

  const deps: ReviewDependencies = {
    policy: {
      repositories: new Set(["acme/app"]),
      baseBranch: "main",
      requiredChecks: ["test"],
      minApprovals: 1,
      mergeMethod: "squash",
      dryRun: false,
    },
    store,
    github: {
      snapshot: () => Promise.resolve(pr),
      prsForCommit: () => Promise.resolve([]),
      async merge(actual, sha, method, reason, beforeMerge) {
        assert.deepEqual(actual, target);
        assert.equal(sha, pr.head);
        assert.equal(method, "squash");
        await beforeMerge?.();
        merges.push(reason);

        return { merged: true, message: "Merged" };
      },
      postComment(actual, sha, body) {
        assert.deepEqual(actual, target);
        assert.equal(sha, pr.head);

        if (failComment) {
          return Promise.reject(new Error("Comment failed"));
        }

        comments.push(body);

        return Promise.resolve();
      },
    },
  };

  return {
    deps,
    data,
    comments,
    merges,
    change: (patch: Partial<Snapshot>) => {
      pr = { ...pr, ...patch };
    },
    fail: (value: boolean) => {
      failComment = value;
    },
    prepare() {
      return prepareReview(target, deps);
    },
  };
}

await test("the main agent receives the diff and can post its own review", async () => {
  const f = fixture();
  const context = await f.prepare();
  assert.deepEqual(context.files, snapshot().files);

  const result = await postComment(
    target,
    { reviewId: context.reviewId, body: "No concrete defects found." },
    f.deps,
  );

  assert.equal(result.outcome, "commented");
  assert.deepEqual(f.comments, ["No concrete defects found."]);
});

await Promise.all(
  [
    { head: "new-head" },
    { base: "new-base" },
    { title: "Changed goal" },
    { body: "Changed description" },
    { files: [] },
  ].map(async (patch) => {
    await test(`changed review input rejects a stale comment: ${Object.keys(patch)[0]}`, async () => {
      const f = fixture();
      const context = await f.prepare();
      f.change(patch);
      await assert.rejects(
        postComment(target, { reviewId: context.reviewId, body: "Review" }, f.deps),
        /PR changed/,
      );
      assert.deepEqual(f.comments, []);
    });
  }),
);

await test("context cannot be reused for another webhook delivery", async () => {
  const f = fixture();
  const context = await f.prepare();
  await assert.rejects(
    postComment(
      { ...target, delivery: "other" },
      { reviewId: context.reviewId, body: "Review" },
      f.deps,
    ),
    /context is missing/,
  );
});

await test("closed PRs skip posting", async () => {
  const f = fixture();
  const context = await f.prepare();
  f.change({ state: "closed" });
  assert.equal(
    (await postComment(target, { reviewId: context.reviewId, body: "Review" }, f.deps)).outcome,
    "skipped",
  );
  assert.deepEqual(f.comments, []);
});

await test("incomplete diffs are identified without including oversized or partial patches", async () => {
  const f = fixture();
  f.change({ completeDiff: false });
  const context = await f.prepare();
  assert.equal(context.completeDiff, false);
  assert.deepEqual(context.files, []);
});

await test("comment failures release the lock and remain retryable", async () => {
  const f = fixture();
  const context = await f.prepare();
  const input = { reviewId: context.reviewId, body: "Review" };
  f.fail(true);
  await assert.rejects(postComment(target, input, f.deps), /Comment failed/);
  f.fail(false);
  assert.equal((await postComment(target, input, f.deps)).outcome, "commented");
});

await test("concurrent posting is rejected", async () => {
  const f = fixture();
  const context = await f.prepare();
  f.data.set("pr-bot:lock:acme/app:42", "other");
  await assert.rejects(
    postComment(target, { reviewId: context.reviewId, body: "Review" }, f.deps),
    /already being posted/,
  );
});

await test("untrusted principals and disallowed targets are rejected", async () => {
  assert.throws(() => verifiedTarget(null), /Verified webhook/);
  assert.throws(
    () => verifiedTarget({ authenticator: "github-app", principalType: "user" }),
    /Verified webhook/,
  );
  const f = fixture();
  await assert.rejects(
    prepareReview({ ...target, repository: "other/app" }, f.deps),
    /not allowed/,
  );
  await assert.rejects(
    postComment(
      { ...target, repository: "other/app" },
      { reviewId: "0".repeat(64), body: "Review" },
      f.deps,
    ),
    /not allowed/,
  );
});

await test("merge is rejected before post-comment succeeds", async () => {
  const f = fixture();
  await f.prepare();
  await assert.rejects(mergePullRequest(target, f.deps), /post-comment must succeed/);
  assert.deepEqual(f.merges, []);
});

await test("a failed comment does not authorize merging", async () => {
  const f = fixture();
  const context = await f.prepare();
  f.fail(true);
  await assert.rejects(postComment(target, { reviewId: context.reviewId, body: "Review" }, f.deps));
  await assert.rejects(mergePullRequest(target, f.deps), /post-comment must succeed/);
});

await test("a posted review permits merging only the reviewed content", async () => {
  const f = fixture();
  const context = await f.prepare();
  await postComment(
    target,
    { reviewId: context.reviewId, body: "No concrete defects found." },
    f.deps,
  );
  assert.equal((await mergePullRequest(target, f.deps)).outcome, "merged");
  assert.deepEqual(f.merges, ["No concrete defects found."]);
  f.change({ head: "new-head" });
  await assert.rejects(mergePullRequest(target, f.deps), /PR changed since/);
});

await test("a posted review from another delivery does not authorize merging", async () => {
  const f = fixture();
  const context = await f.prepare();
  await postComment(target, { reviewId: context.reviewId, body: "Review" }, f.deps);
  await assert.rejects(
    mergePullRequest({ ...target, delivery: "other" }, f.deps),
    /post-comment must succeed/,
  );
});

await test("merge rechecks CI and dry-run policy after posting", async () => {
  const f = fixture();
  const context = await f.prepare();
  await postComment(target, { reviewId: context.reviewId, body: "Review" }, f.deps);
  f.change({ checks: [{ name: "test", success: false }] });
  assert.equal((await mergePullRequest(target, f.deps)).outcome, "held");
  f.change({ checks: [{ name: "test", success: true }] });
  assert.equal(
    (await mergePullRequest(target, { ...f.deps, policy: { ...f.deps.policy, dryRun: true } }))
      .outcome,
    "dry-run",
  );
  assert.deepEqual(f.merges, []);
});

const blockedStates: readonly Partial<Snapshot>[] = [
  { state: "closed" },
  { merged: true },
  { draft: true },
  { baseBranch: "release" },
  { mergeable: false },
  { mergeableState: "dirty" },
  { approvals: [] },
  { changesRequested: true },
  { checks: [] },
  { checks: [{ name: "other", success: true }] },
  { completeDiff: false },
];

await Promise.all(
  blockedStates.map(async (patch) => {
    await test(`posting a review does not bypass merge policy: ${Object.keys(patch)[0]}`, async () => {
      const f = fixture();
      const context = await f.prepare();
      await postComment(target, { reviewId: context.reviewId, body: "Review" }, f.deps);
      f.change(patch);

      // A changed diff is rejected before policy evaluation; other blockers return held.
      if (patch.completeDiff === false) {
        await assert.rejects(mergePullRequest(target, f.deps), /PR changed since/);
      } else {
        assert.equal((await mergePullRequest(target, f.deps)).outcome, "held");
      }

      assert.deepEqual(f.merges, []);
    });
  }),
);
