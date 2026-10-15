import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { parseEvent, verifySignature } from '../src/webhook.js';

const repository = { full_name: 'Acme/App' };
test('verifies exact raw bytes and rejects forged, malformed and missing signatures', () => {
  const body = Buffer.from('{ "action": "opened" }');
  const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`;
  assert.equal(verifySignature(body, signature, 'secret'), true);
  assert.equal(verifySignature(Buffer.from('{"action":"opened"}'), signature, 'secret'), false);
  assert.equal(verifySignature(body, signature, 'different'), false);
  for (const invalid of [null, '', 'sha256=bad', 'sha1=abc', `sha256=${'z'.repeat(64)}`]) assert.equal(verifySignature(body, invalid, 'secret'), false);
});
test('PR and review events map to a normalized repository and PR number', () => {
  for (const [event, action] of [['pull_request', 'synchronize'], ['pull_request_review', 'dismissed']]) {
    assert.deepEqual(parseEvent(event, { repository, action, pull_request: { number: 7 } }), { repository: 'acme/app', numbers: [7], sha: undefined });
  }
});
test('completed checks support PR associations and SHA fallback', () => {
  assert.deepEqual(parseEvent('check_run', { repository, action: 'completed', check_run: { head_sha: 'abc', pull_requests: [{ number: 7 }] } }), { repository: 'acme/app', numbers: [7], sha: 'abc' });
  assert.deepEqual(parseEvent('check_suite', { repository, action: 'completed', check_suite: { head_sha: 'abc', pull_requests: [] } }), { repository: 'acme/app', numbers: [], sha: 'abc' });
  assert.deepEqual(parseEvent('status', { repository, sha: 'abc' }), { repository: 'acme/app', numbers: [], sha: 'abc' });
});
test('irrelevant events never reach the model', () => {
  assert.equal(parseEvent('issue_comment', {}), null);
  assert.equal(parseEvent('pull_request', { repository, action: 'closed', pull_request: { number: 7 } }), null);
  assert.equal(parseEvent('check_run', { repository, action: 'created' }), null);
});
test('invalid targets and incomplete actionable events are rejected', () => {
  assert.throws(() => parseEvent('pull_request', { repository, action: 'opened' }));
  assert.throws(() => parseEvent('pull_request', { repository, action: 'opened', pull_request: { number: -1 } }));
  assert.throws(() => parseEvent('check_run', { repository, action: 'completed' }));
  assert.throws(() => parseEvent('status', { repository }));
});
