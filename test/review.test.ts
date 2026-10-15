import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockers, reviewPullRequest, type Decision } from '../src/review.js';
import type { Config } from '../src/config.js';
import type { GitHub, Snapshot, Target } from '../src/github.js';
import type { Store } from '../src/store.js';

const target: Target = { repository: 'acme/app', number: 42, delivery: 'delivery-1' };
const policy: Config = {
  repositories: new Set(['acme/app']), baseBranch: 'main', label: 'agent:merge',
  requiredChecks: ['test'], minApprovals: 1, mergeMethod: 'squash', dryRun: false,
};
const snapshot = (): Snapshot => ({
  head: 'head-sha', base: 'base-sha', baseBranch: 'main', state: 'open', draft: false,
  merged: false, mergeable: true, mergeableState: 'clean', labels: ['agent:merge'],
  title: 'Fix edge case', body: '', author: 'author', checks: [{ name: 'test', success: true }],
  approvals: ['reviewer'], changesRequested: false, completeDiff: true,
  files: [{ path: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }],
});
const approval: Decision = { decision: 'merge', reason: 'Change and tests address the edge case', risks: [] };

function fixture(pr = snapshot(), options: { fresh?: Snapshot; decision?: Decision; dryRun?: boolean } = {}) {
  const data = new Map<string, unknown>();
  const store: Store = {
    async get<T>(key: string) { return (data.get(key) as T) ?? null; },
    async set(key, value) { data.set(key, value); },
    async claim(key, token) { if (data.has(key)) return false; data.set(key, token); return true; },
    async release(key, token) { if (data.get(key) === token) data.delete(key); },
  };
  let snapshots = 0, merges = 0, assessments = 0;
  const github: GitHub = {
    async snapshot() { return structuredClone(snapshots++ === 0 ? pr : options.fresh ?? pr); },
    async prsForCommit() { return [42]; },
    async merge(actual, sha, method) {
      assert.deepEqual(actual, target); assert.equal(sha, pr.head); assert.equal(method, 'squash');
      merges++; return { merged: true, sha, message: 'Merged' };
    },
  };
  return {
    deps: { github, store, policy: { ...policy, dryRun: options.dryRun ?? false }, async assess() { assessments++; return options.decision ?? approval; } },
    counts: () => ({ snapshots, merges, assessments }), data,
  };
}

test('merges eligible PR with the exact reviewed head SHA', async () => {
  const f = fixture();
  assert.equal((await reviewPullRequest(target, f.deps)).outcome, 'merged');
  assert.deepEqual(f.counts(), { snapshots: 2, merges: 1, assessments: 1 });
});
test('duplicate delivery returns cached result without repeating review or merge', async () => {
  const f = fixture();
  const first = await reviewPullRequest(target, f.deps);
  assert.deepEqual(await reviewPullRequest(target, f.deps), first);
  assert.equal(f.counts().merges, 1); assert.equal(f.counts().assessments, 1);
});
for (const [name, change] of Object.entries<Partial<Snapshot>>({
  draft: { draft: true }, closed: { state: 'closed' }, merged: { merged: true },
  branch: { baseBranch: 'release' }, label: { labels: [] }, approvals: { approvals: [] },
  'changes requested': { changesRequested: true }, missingCI: { checks: [] },
  failingCI: { checks: [{ name: 'test', success: false }] },
  unknownMergeability: { mergeable: null }, blocked: { mergeableState: 'blocked' },
  behind: { mergeableState: 'behind' }, truncatedDiff: { completeDiff: false }, emptyDiff: { files: [] },
})) {
  test(`holds ${name} before spending model tokens`, async () => {
    const f = fixture({ ...snapshot(), ...change });
    assert.equal((await reviewPullRequest(target, f.deps)).outcome, 'held');
    assert.equal(f.counts().assessments, 0); assert.equal(f.counts().merges, 0);
  });
}
test('any unsuccessful optional check also blocks', () => {
  assert.ok(blockers({ ...snapshot(), checks: [...snapshot().checks, { name: 'lint', success: false }] }, policy).length);
});
for (const [name, change] of Object.entries<Partial<Snapshot>>({
  head: { head: 'new-head' }, base: { base: 'new-base' }, removedLabel: { labels: [] },
  dismissedApproval: { approvals: [] }, failingCI: { checks: [{ name: 'test', success: false }] },
  editedDescription: { body: 'Changed scope' }, changedPatch: { files: [{ path: 'other', status: 'added', patch: '+danger' }] },
})) {
  test(`holds when ${name} changes during model review`, async () => {
    const f = fixture(snapshot(), { fresh: { ...snapshot(), ...change } });
    assert.equal((await reviewPullRequest(target, f.deps)).outcome, 'held');
    assert.equal(f.counts().merges, 0);
  });
}
test('dry-run reports a candidate without merging', async () => {
  const f = fixture(snapshot(), { dryRun: true });
  assert.equal((await reviewPullRequest(target, f.deps)).outcome, 'dry-run'); assert.equal(f.counts().merges, 0);
});
for (const decision of [{ ...approval, decision: 'hold' as const }, { ...approval, risks: ['Missing test'] }]) {
  test(`model ${JSON.stringify(decision)} prevents merge`, async () => {
    const f = fixture(snapshot(), { decision });
    assert.equal((await reviewPullRequest(target, f.deps)).outcome, 'held'); assert.equal(f.counts().merges, 0);
  });
}
test('repository allowlist cannot be bypassed through tool input', async () => {
  const f = fixture();
  await assert.rejects(reviewPullRequest({ ...target, repository: 'evil/app' }, f.deps), /not allowed/);
  assert.equal(f.counts().snapshots, 0);
});
test('concurrent evaluation cannot acquire the same PR lock', async () => {
  const f = fixture();
  f.data.set('pr-bot:lock:acme/app:42', 'other-owner');
  await assert.rejects(reviewPullRequest(target, f.deps), /already running/);
  assert.equal(f.counts().merges, 0);
});
test('lost lease prevents merge', async () => {
  const f = fixture();
  f.deps.assess = async () => { f.data.set('pr-bot:lock:acme/app:42', 'new-owner'); return approval; };
  await assert.rejects(reviewPullRequest(target, f.deps), /lock expired/);
  assert.equal(f.counts().merges, 0);
  assert.equal(f.data.get('pr-bot:lock:acme/app:42'), 'new-owner');
});
test('model failure releases lock and leaves delivery retryable', async () => {
  const f = fixture(); f.deps.assess = async () => { throw new Error('provider unavailable'); };
  await assert.rejects(reviewPullRequest(target, f.deps), /provider unavailable/);
  assert.equal(f.data.size, 0); assert.equal(f.counts().merges, 0);
});
test('malformed model output cannot authorize a merge', async () => {
  const f = fixture(); f.deps.assess = async () => JSON.parse('{"decision":"merge"}');
  await assert.rejects(reviewPullRequest(target, f.deps)); assert.equal(f.counts().merges, 0);
});
