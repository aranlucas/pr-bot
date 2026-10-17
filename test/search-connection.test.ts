import { assert, expect, test, vi } from "vitest";

test.each([
  {
    baseURL: undefined,
    expectedURL: "https://freellmapi-production-1175.up.railway.app/mcp",
  },
  {
    baseURL: "http://localhost:3001/v1/",
    expectedURL: "http://localhost:3001/mcp",
  },
])("search connection targets $expectedURL and exposes only search", async (settings) => {
  vi.stubEnv("FREELLM_API_BASE_URL", settings.baseURL);
  vi.stubEnv("FREELLM_API_KEY", "search-test-key");
  vi.resetModules();
  const { default: connection } = await import("../agent/connections/freellm.js");

  assert.strictEqual(connection.url, settings.expectedURL);
  assert.strictEqual(connection.protocolVersionDiscovery, false);
  assert.deepEqual(connection.tools, { allow: ["web_search"] });
  assert.notInclude(JSON.stringify(connection), "search-test-key");
  const auth = connection.auth;
  assert.ok(auth && "getToken" in auth);
  assert.deepEqual(
    await auth.getToken({ principal: { type: "app" }, connection: { url: connection.url } }),
    {
      token: "search-test-key",
    },
  );
});

test("missing credentials fail environment validation when the connection loads", async () => {
  vi.stubEnv("FREELLM_API_KEY", "");
  vi.resetModules();
  await expect(import("../agent/connections/freellm.js")).rejects.toThrow(
    "Invalid environment variables",
  );
});
