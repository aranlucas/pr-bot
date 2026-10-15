import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Octokit } from '@octokit/rest';
import { createGitHub } from '../src/github.js';

function client(options: { reviews?: object[]; files?: object[]; changedFiles?: number; statuses?: object[] } = {}) {
  const calls: string[] = [];
  const api = new Octokit({ request: { fetch: async (url: string) => {
    const path = new URL(url).pathname;
    calls.push(path);
    let data: unknown;
    if (path.endsWith('/pulls/42')) data = {
      head: { sha: 'head' }, base: { sha: 'base', ref: 'main' }, state: 'open', merged: false,
      draft: false, mergeable: true, mergeable_state: 'clean', title: 'Fix', body: '',
      user: { login: 'author' }, labels: [{ name: 'agent:merge' }], changed_files: options.changedFiles ?? 1,
    };
    else if (path.endsWith('/files')) data = options.files ?? [{ filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1 }];
    else if (path.endsWith('/check-runs')) data = { total_count: 1, check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] };
    else if (path.endsWith('/statuses')) data = options.statuses ?? [];
    else if (path.endsWith('/reviews')) data = options.reviews ?? [];
    else if (path.includes('/collaborators/')) data = { permission: path.includes('/outsider/') ? 'read' : 'write' };
    else throw new Error(`Unexpected API route ${path}`);
    const response = new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url });
    return response;
  } } });
  return { github: createGitHub(api), calls };
}
const target = { repository: 'acme/app', number: 42, delivery: 'one' };
const review = (id: number, login: string, state = 'APPROVED', commit_id = 'head', type = 'User') => ({ id, user: { login, type }, state, commit_id });

test('only current-head, human, non-author write collaborators count as approvals', async () => {
  const f = client({ reviews: [review(1, 'author'), review(2, 'old', 'APPROVED', 'old-head'), review(3, 'bot', 'APPROVED', 'head', 'Bot'), review(4, 'outsider'), review(5, 'maintainer')] });
  assert.deepEqual((await f.github.snapshot(target)).approvals, ['maintainer']);
  assert.equal(f.calls.filter(path => path.includes('/collaborators/')).length, 2);
});
test('dismissed approvals are removed, comments do not replace a decision, and requests for changes remain blocking', async () => {
  const f = client({ reviews: [review(1, 'a'), review(2, 'a', 'DISMISSED'), review(3, 'b', 'CHANGES_REQUESTED'), review(4, 'b', 'COMMENTED'), review(5, 'c'), review(6, 'c', 'COMMENTED')] });
  const pr = await f.github.snapshot(target);
  assert.deepEqual(pr.approvals, ['c']); assert.equal(pr.changesRequested, true);
});
test('latest decisive review replaces earlier changes requested', async () => {
  const f = client({ reviews: [review(2, 'a'), review(1, 'a', 'CHANGES_REQUESTED')] });
  const pr = await f.github.snapshot(target);
  assert.deepEqual(pr.approvals, ['a']); assert.equal(pr.changesRequested, false);
});
test('latest status per context wins even if API data is out of order', async () => {
  const f = client({ statuses: [{ id: 1, context: 'legacy', state: 'failure' }, { id: 3, context: 'legacy', state: 'success' }, { id: 2, context: 'other', state: 'pending' }] });
  assert.deepEqual((await f.github.snapshot(target)).checks, [{ name: 'legacy', success: true }, { name: 'other', success: false }, { name: 'test', success: true }]);
});
for (const [name, options] of Object.entries({
  binary: { files: [{ filename: 'image.png', status: 'added', additions: 0, deletions: 0 }] },
  truncatedPatch: { files: [{ filename: 'a.ts', status: 'modified', patch: '+one line', additions: 100, deletions: 0 }] },
  truncatedFileList: { changedFiles: 101 },
})) {
  test(`${name} is identified as an incomplete diff`, async () => {
    assert.equal((await client(options).github.snapshot(target)).completeDiff, false);
  });
}
test('a full text patch is accepted as complete', async () => {
  assert.equal((await client().github.snapshot(target)).completeDiff, true);
});
