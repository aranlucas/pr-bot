import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { parseEvent, verifySignature } from "@/webhook";

const repository = { id: 123, full_name: "Acme/App" } as const;

interface PullNumber {
  readonly number: number;
}

interface CheckPayload {
  readonly head_sha: string;
  readonly pull_requests: readonly PullNumber[];
}

interface EventPayload {
  readonly repository?: typeof repository;
  readonly action?: string;
  readonly pull_request?: PullNumber;
  readonly check_run?: CheckPayload;
  readonly check_suite?: CheckPayload;
  readonly sha?: string;
}

function payload(value: EventPayload): string {
  return JSON.stringify({ installation: { id: 99 }, ...value });
}

await test("verifies exact raw bytes and rejects forged, malformed and missing signatures", async () => {
  const body = Buffer.from('{ "action": "opened" }');
  const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
  assert.equal(await verifySignature(body, signature, "secret"), true);
  assert.equal(
    await verifySignature(Buffer.from('{"action":"opened"}'), signature, "secret"),
    false,
  );
  assert.equal(await verifySignature(body, signature, "different"), false);

  await Promise.all(
    [null, "", "sha256=bad", "sha1=abc", `sha256=${"z".repeat(64)}`].map(async (invalid) => {
      assert.equal(await verifySignature(body, invalid, "secret"), false);
    }),
  );
  assert.equal(await verifySignature(Buffer.alloc(0), signature, "secret"), false);
  // Octokit's verifier accepts strings; invalid UTF-8 must never be replaced before verification.
  const invalidUtf8 = Buffer.from([0xff]);
  const replacementSignature = `sha256=${createHmac("sha256", "secret").update("�").digest("hex")}`;
  assert.equal(await verifySignature(invalidUtf8, replacementSignature, "secret"), false);
});

await test("PR and review events map to a normalized repository and PR number", () => {
  for (const [event, action] of [
    ["pull_request", "synchronize"],
    ["pull_request_review", "dismissed"],
  ]) {
    assert.deepEqual(
      parseEvent(event, payload({ repository, action, pull_request: { number: 7 } })),
      {
        repository: "acme/app",
        repositoryId: 123,
        installationId: 99,
        numbers: [7],
        sha: undefined,
      },
    );
  }
});

await test("completed checks support PR associations and SHA fallback", () => {
  assert.deepEqual(
    parseEvent(
      "check_run",
      payload({
        repository,
        action: "completed",
        check_run: { head_sha: "abc", pull_requests: [{ number: 7 }] },
      }),
    ),
    { repository: "acme/app", repositoryId: 123, installationId: 99, numbers: [7], sha: "abc" },
  );
  assert.deepEqual(
    parseEvent(
      "check_suite",
      payload({
        repository,
        action: "completed",
        check_suite: { head_sha: "abc", pull_requests: [] },
      }),
    ),
    { repository: "acme/app", repositoryId: 123, installationId: 99, numbers: [], sha: "abc" },
  );
  assert.deepEqual(parseEvent("status", payload({ repository, sha: "abc" })), {
    repository: "acme/app",
    repositoryId: 123,
    installationId: 99,
    numbers: [],
    sha: "abc",
  });
});

await test("irrelevant events never reach the model", () => {
  assert.equal(parseEvent("issue_comment", payload({})), null);
  assert.equal(
    parseEvent(
      "pull_request",
      payload({ repository, action: "closed", pull_request: { number: 7 } }),
    ),
    null,
  );
  assert.equal(parseEvent("check_run", payload({ repository, action: "created" })), null);
});

await test("invalid targets and incomplete actionable events are rejected", () => {
  assert.throws(() => parseEvent("pull_request", payload({ repository, action: "opened" })));
  assert.throws(() =>
    parseEvent(
      "pull_request",
      payload({ repository, action: "opened", pull_request: { number: -1 } }),
    ),
  );
  assert.throws(() => parseEvent("check_run", payload({ repository, action: "completed" })));
  assert.throws(() => parseEvent("status", payload({ repository })));
});

await test("check targets come from check associations even when an unrelated PR field is present", () => {
  const event = parseEvent(
    "check_run",
    payload({
      repository,
      action: "completed",
      pull_request: { number: 999 },
      check_run: { head_sha: "head", pull_requests: [{ number: 7 }] },
    }),
  );

  assert.deepEqual(event?.numbers, [7]);
});
