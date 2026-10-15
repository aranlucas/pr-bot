import assert from "node:assert/strict";
import { test } from "node:test";
import { freeModelId } from "../src/model.js";

await test("only explicitly free model routes are allowed", () => {
  assert.equal(freeModelId("openrouter/free"), "openrouter/free");
  assert.equal(freeModelId("provider/model:free"), "provider/model:free");
  assert.throws(() => freeModelId("anthropic/claude-sonnet-4.5"), /must use/);
  assert.throws(() => freeModelId("openrouter/auto"), /must use/);
});
