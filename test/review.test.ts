import assert from "node:assert/strict";
import { test } from "node:test";
import { blockers, reviewPullRequest, type Decision } from "../src/review.js";
import type { Config } from "../src/config.js";
import type { GitHub, Snapshot, Target } from "../src/github.js";
import type { Store } from "../src/store.js";

const target: Target = { repository: "acme/app", number: 42, delivery: "delivery-1" };

const policy: Config = {
  repositories: new Set(["acme/app"]),
  baseBranch: "main",
  requiredChecks: ["test"],
  minApprovals: 1,
  mergeMethod: "squash",
  dryRun: false,
};

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

const approval: Decision = {
  decision: "merge",
  reason: "Change and tests address the edge case",
  risks: [],
};

interface FixtureOptions {
  readonly fresh?: Snapshot;
  readonly decision?: Decision;
  readonly dryRun?: boolean;
}

function fixture(pr = snapshot(), options: FixtureOptions = {}) {
  const data = new Map<string, unknown>();

  const store: Store = {
    get<T>(key: string) {
      // SAFETY: The fake stores values under the same typed keys that the tested caller reads.
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

  let snapshots = 0;
  let merges = 0;
  let assessments = 0;

  const github: GitHub = {
    snapshot() {
      return Promise.resolve(structuredClone(snapshots++ === 0 ? pr : (options.fresh ?? pr)));
    },
    prsForCommit() {
      return Promise.resolve([42]);
    },
    merge(actual, sha, method) {
      assert.deepEqual(actual, target);
      assert.equal(sha, pr.head);
      assert.equal(method, "squash");
      merges++;

      return Promise.resolve({ merged: true, sha, message: "Merged" });
    },
  };

  return {
    deps: {
      github,
      store,
      policy: { ...policy, dryRun: options.dryRun ?? false },
      assess() {
        assessments++;

        return Promise.resolve(options.decision ?? approval);
      },
    },
    counts: () => ({ snapshots, merges, assessments }),
    data,
  };
}

await test("merges eligible PR with the exact reviewed head SHA", async () => {
  const f = fixture();
  assert.equal((await reviewPullRequest(target, f.deps)).outcome, "merged");
  assert.deepEqual(f.counts(), { snapshots: 2, merges: 1, assessments: 1 });
});

await test("duplicate delivery returns cached result without repeating review or merge", async () => {
  const f = fixture();
  const first = await reviewPullRequest(target, f.deps);
  assert.deepEqual(await reviewPullRequest(target, f.deps), first);
  assert.equal(f.counts().merges, 1);
  assert.equal(f.counts().assessments, 1);
});

await Promise.all(
  Object.entries<Partial<Snapshot>>({
    draft: { draft: true },
    closed: { state: "closed" },
    merged: { merged: true },
    branch: { baseBranch: "release" },
    approvals: { approvals: [] },
    "changes requested": { changesRequested: true },
    missingCI: { checks: [] },
    failingCI: { checks: [{ name: "test", success: false }] },
    unknownMergeability: { mergeable: null },
    blocked: { mergeableState: "blocked" },
    behind: { mergeableState: "behind" },
    truncatedDiff: { completeDiff: false },
    emptyDiff: { files: [] },
  }).map(async ([name, change]) => {
    await test(`holds ${name} without merging`, async () => {
      const f = fixture({ ...snapshot(), ...change });
      assert.equal((await reviewPullRequest(target, f.deps)).outcome, "held");
      assert.equal(
        f.counts().assessments,
        ["closed", "merged", "truncatedDiff", "emptyDiff"].includes(name) ? 0 : 1,
      );
      assert.equal(f.counts().merges, 0);
    });
  }),
);

await test("any unsuccessful optional check also blocks", () => {
  assert.ok(
    blockers(
      { ...snapshot(), checks: [...snapshot().checks, { name: "lint", success: false }] },
      policy,
    ).length,
  );
});

await Promise.all(
  Object.entries<Partial<Snapshot>>({
    head: { head: "new-head" },
    base: { base: "new-base" },
    dismissedApproval: { approvals: [] },
    failingCI: { checks: [{ name: "test", success: false }] },
    editedDescription: { body: "Changed scope" },
    changedPatch: { files: [{ path: "other", status: "added", patch: "+danger" }] },
  }).map(async ([name, change]) => {
    await test(`holds when ${name} changes during model review`, async () => {
      const f = fixture(snapshot(), { fresh: { ...snapshot(), ...change } });
      assert.equal((await reviewPullRequest(target, f.deps)).outcome, "held");
      assert.equal(f.counts().merges, 0);
    });
  }),
);

await test("dry-run reports a candidate without merging", async () => {
  const f = fixture(snapshot(), { dryRun: true });
  assert.equal((await reviewPullRequest(target, f.deps)).outcome, "dry-run");
  assert.equal(f.counts().merges, 0);
});

await Promise.all(
  [
    { ...approval, decision: "hold" as const },
    { ...approval, risks: ["Missing test"] },
  ].map(async (decision) => {
    await test(`model ${JSON.stringify(decision)} prevents merge`, async () => {
      const f = fixture(snapshot(), { decision });
      assert.equal((await reviewPullRequest(target, f.deps)).outcome, "held");
      assert.equal(f.counts().merges, 0);
    });
  }),
);

await test("repository allowlist cannot be bypassed through tool input", async () => {
  const f = fixture();
  await assert.rejects(
    reviewPullRequest({ ...target, repository: "evil/app" }, f.deps),
    /not allowed/,
  );
  assert.equal(f.counts().snapshots, 0);
});

await test("concurrent evaluation cannot acquire the same PR lock", async () => {
  const f = fixture();
  f.data.set("pr-bot:lock:acme/app:42", "other-owner");
  await assert.rejects(reviewPullRequest(target, f.deps), /already running/);
  assert.equal(f.counts().merges, 0);
});

await test("lost lease prevents merge", async () => {
  const f = fixture();
  f.deps.assess = () => {
    f.data.set("pr-bot:lock:acme/app:42", "new-owner");

    return Promise.resolve(approval);
  };

  await assert.rejects(reviewPullRequest(target, f.deps), /lock expired/);
  assert.equal(f.counts().merges, 0);
  assert.equal(f.data.get("pr-bot:lock:acme/app:42"), "new-owner");
});

await test("model failure releases lock and leaves delivery retryable", async () => {
  const f = fixture();
  f.deps.assess = () => {
    return Promise.reject(new Error("provider unavailable"));
  };

  await assert.rejects(reviewPullRequest(target, f.deps), /provider unavailable/);
  assert.equal(f.data.size, 0);
  assert.equal(f.counts().merges, 0);
});

await test("malformed model output cannot authorize a merge", async () => {
  const f = fixture();
  // SAFETY: Intentionally invalid provider output exercises runtime schema validation.
  f.deps.assess = () => Promise.resolve(JSON.parse('{"decision":"merge"}') as Decision);
  await assert.rejects(reviewPullRequest(target, f.deps));
  assert.equal(f.counts().merges, 0);
});

await test("unlabeled PRs are reviewed and may merge when all other gates pass", async () => {
  const f = fixture({ ...snapshot(), labels: [] });
  assert.equal((await reviewPullRequest(target, f.deps)).outcome, "merged");
  assert.equal(f.counts().assessments, 1);
});

await test("owner wildcard permits the owner without admitting a similarly named account", async () => {
  const f = fixture();
  f.deps.policy = { ...policy, repositories: new Set(["acme/*"]) };
  assert.equal((await reviewPullRequest(target, f.deps)).outcome, "merged");
  await assert.rejects(
    reviewPullRequest({ ...target, repository: "acme-other/app" }, f.deps),
    /not allowed/,
  );
});

await test("default branch policy supports repositories using master", () => {
  const pr = { ...snapshot(), baseBranch: "master", defaultBranch: "master" };
  assert.deepEqual(blockers(pr, { ...policy, baseBranch: "default" }), []);
});

await test("wildcard CI names still require at least one check", () => {
  assert.ok(
    blockers({ ...snapshot(), checks: [] }, { ...policy, requiredChecks: [] }).includes(
      "No CI checks are present",
    ),
  );
});

await test("different webhook deliveries reuse the same code review", async () => {
  const f = fixture(snapshot(), { dryRun: true });
  await reviewPullRequest(target, f.deps);
  await reviewPullRequest({ ...target, delivery: "delivery-2" }, f.deps);
  assert.equal(f.counts().assessments, 1);
});
