import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "@/config";

await test("approval policy defaults to zero, accepts opt-in counts and rejects negatives", (t) => {
  const previous = process.env;
  process.env = { GITHUB_REPOSITORIES: "acme/*" };
  t.after(() => {
    process.env = previous;
  });
  assert.equal(config().minApprovals, 0);
  process.env.MIN_APPROVALS = "0";
  assert.equal(config().minApprovals, 0);
  process.env.MIN_APPROVALS = "2";
  assert.equal(config().minApprovals, 2);
  process.env.MIN_APPROVALS = "-1";
  assert.throws(() => config());
});
