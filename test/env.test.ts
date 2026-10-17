import { assert, expect, test, vi } from "vitest";

test("empty optional settings receive defaults and PEM newlines are normalized", async () => {
  vi.stubEnv("CONTEXT7_API_KEY", "");
  vi.stubEnv("FREELLM_API_BASE_URL", "");
  vi.stubEnv("FREELLM_API_KEY", "");
  vi.stubEnv("FREELLM_MODEL", "");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", String.raw`first\nsecond`);
  vi.resetModules();

  const { env } = await import("@/env");

  assert.strictEqual(env.CONTEXT7_API_KEY, undefined);
  assert.strictEqual(
    env.FREELLM_API_BASE_URL,
    "https://freellmapi-production-1175.up.railway.app/v1",
  );
  assert.strictEqual(env.FREELLM_API_KEY, "");
  assert.strictEqual(env.FREELLM_MODEL, "auto");
  assert.strictEqual(env.GITHUB_APP_PRIVATE_KEY, "first\nsecond");
});

test("explicit model settings and real PEM newlines are preserved", async () => {
  vi.stubEnv("FREELLM_API_BASE_URL", "https://openrouter.ai/api/v1");
  vi.stubEnv("FREELLM_API_KEY", "test-key");
  vi.stubEnv("FREELLM_MODEL", "test-model");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "first\nsecond");
  vi.resetModules();

  const { env } = await import("@/env");

  assert.strictEqual(env.FREELLM_API_BASE_URL, "https://openrouter.ai/api/v1");
  assert.strictEqual(env.FREELLM_API_KEY, "test-key");
  assert.strictEqual(env.FREELLM_MODEL, "test-model");
  assert.strictEqual(env.GITHUB_APP_PRIVATE_KEY, "first\nsecond");
});

test.each(["GITHUB_APP_ID", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_PRIVATE_KEY"])(
  "rejects missing %s even with the old validation bypass set",
  async (variable) => {
    vi.stubEnv(variable, "");
    vi.stubEnv("SKIP_ENV_VALIDATION", "1");
    vi.resetModules();

    await expect(import("@/env")).rejects.toThrow(new RegExp(variable));
  },
);

test("rejects an invalid model endpoint", async () => {
  vi.stubEnv("FREELLM_API_BASE_URL", "invalid-url");
  vi.resetModules();

  await expect(import("@/env")).rejects.toThrow(/FREELLM_API_BASE_URL/);
});
