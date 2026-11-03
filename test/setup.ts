import { generateKeyPairSync } from "node:crypto";
import { vi } from "vitest";
import type * as OctokitModule from "octokit";

// Requests use fixture fetch responses. Keep Octokit's real auth, routing and
// serialization, but skip its three-second notification throttle in tests.
// oxlint-disable-next-line anti-slop/no-module-mocking -- SDK constructs Octokit internally; configure its real client rather than replacing GitHub behavior.
vi.mock("octokit", async (importOriginal) => {
  const original = await importOriginal<typeof OctokitModule>();

  return {
    ...original,
    Octokit: original.Octokit.defaults({ throttle: { enabled: false } }),
  };
});

// `@/env` validates when first imported, so App credentials must exist before
// any test module loads the agent.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

process.env.GITHUB_APP_ID = "123";

process.env.FREELLM_API_KEY = "test-model-key";

process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });

process.env.GITHUB_WEBHOOK_SECRET = "secret";
