import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionAuthContext } from "eve/context";
import { serializeModelInputSchema, type ToolContext } from "eve/tools";
import reviewTool, { createReviewTool } from "../agent/tools/review-pull-request.js";
import { reviewAuth } from "@/github-channel";
import type { Target } from "@/github";

const target: Target = {
  repository: "acme/app",
  number: 42,
  delivery: "delivery-1",
  installationId: 99,
};

function toolContext(
  current: SessionAuthContext | null,
  initiator: SessionAuthContext | null = null,
): ToolContext {
  // SAFETY: The tool accesses only session.auth; omitted runtime capabilities must not be used.
  return { session: { auth: { current, initiator } } } as ToolContext;
}

await test("the tool accepts no model-supplied target and ends the turn", () => {
  assert.equal(reviewTool.endsTurn, true);
  assert.equal(reviewTool.availableInSubagents, false);
  assert.deepEqual(serializeModelInputSchema(reviewTool.inputSchema).properties, {});
});

await test("the executor uses the current webhook principal rather than the session initiator", async () => {
  const calls: Target[] = [];

  const tool = createReviewTool((actual) => {
    calls.push(actual);

    return Promise.resolve({ outcome: "held", reason: "Waiting on CI" });
  });

  const result = await tool.execute(
    {},
    toolContext(reviewAuth(target), reviewAuth({ ...target, repository: "old/app", number: 1 })),
  );

  assert.deepEqual(calls, [target]);
  assert.deepEqual(result, { outcome: "held", reason: "Waiting on CI" });
});

await Promise.all(
  [
    null,
    { ...reviewAuth(target), authenticator: "other" },
    { ...reviewAuth(target), principalType: "user" },
  ].map(async (principal) => {
    await test(`the executor rejects an unverified caller: ${JSON.stringify(principal)}`, () => {
      let called = false;

      const tool = createReviewTool(() => {
        called = true;

        return Promise.resolve({ outcome: "merged", reason: "Unexpected" });
      });

      assert.throws(
        () => tool.execute({}, toolContext(principal, reviewAuth(target))),
        /Verified webhook/,
      );
      assert.equal(called, false);
    });
  }),
);

await Promise.all(
  [
    { number: "0" },
    { number: "1.5" },
    { installationId: "0" },
    { installationId: "not-a-number" },
    { delivery: [] },
  ].map(async (attributes) => {
    await test(`the executor rejects malformed verified attributes: ${JSON.stringify(attributes)}`, () => {
      let called = false;

      const tool = createReviewTool(() => {
        called = true;

        return Promise.resolve({ outcome: "merged", reason: "Unexpected" });
      });

      assert.throws(() =>
        tool.execute(
          {},
          toolContext({
            ...reviewAuth(target),
            attributes: { ...reviewAuth(target).attributes, ...attributes },
          }),
        ),
      );
      assert.equal(called, false);
    });
  }),
);

await test("review failures propagate through the tool rather than reporting success", async () => {
  const tool = createReviewTool(() => Promise.reject(new Error("Redis unavailable")));
  await assert.rejects(async () => {
    await tool.execute({}, toolContext(reviewAuth(target)));
  }, /Redis unavailable/);
});
