import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { parseEvent, verifySignature } from "@/webhook";

const repository = { full_name: "Acme/App" };

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
      parseEvent(event, JSON.stringify({ repository, action, pull_request: { number: 7 } })),
      {
        repository: "acme/app",
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
      JSON.stringify({
        repository,
        action: "completed",
        check_run: { head_sha: "abc", pull_requests: [{ number: 7 }] },
      }),
    ),
    { repository: "acme/app", numbers: [7], sha: "abc" },
  );
  assert.deepEqual(
    parseEvent(
      "check_suite",
      JSON.stringify({
        repository,
        action: "completed",
        check_suite: { head_sha: "abc", pull_requests: [] },
      }),
    ),
    { repository: "acme/app", numbers: [], sha: "abc" },
  );
  assert.deepEqual(parseEvent("status", JSON.stringify({ repository, sha: "abc" })), {
    repository: "acme/app",
    numbers: [],
    sha: "abc",
  });
});

await test("irrelevant events never reach the model", () => {
  assert.equal(parseEvent("issue_comment", JSON.stringify({})), null);
  assert.equal(
    parseEvent(
      "pull_request",
      JSON.stringify({ repository, action: "closed", pull_request: { number: 7 } }),
    ),
    null,
  );
  assert.equal(parseEvent("check_run", JSON.stringify({ repository, action: "created" })), null);
});

await test("invalid targets and incomplete actionable events are rejected", () => {
  assert.throws(() => parseEvent("pull_request", JSON.stringify({ repository, action: "opened" })));
  assert.throws(() =>
    parseEvent(
      "pull_request",
      JSON.stringify({ repository, action: "opened", pull_request: { number: -1 } }),
    ),
  );
  assert.throws(() => parseEvent("check_run", JSON.stringify({ repository, action: "completed" })));
  assert.throws(() => parseEvent("status", JSON.stringify({ repository })));
});
