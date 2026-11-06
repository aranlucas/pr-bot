import { assert, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";

beforeEach(() => {
  vi.resetModules();
});

test.each([
  { status: 404, body: { message: "Not found" } },
  { status: 200, body: { id: 5335315 } },
  { status: 200, body: { slug: "" } },
  { status: 200, body: { slug: "untrusted/account" } },
])("App identity failures are retried on the next call: %j", async ({ status, body }) => {
  const { githubBotLogin } = await import("../agent/lib/github.js");

  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() => Promise.resolve(Response.json(body, { status })));

  await expect(githubBotLogin()).rejects.toThrow(
    status === 404 ? "GitHub resource not found" : /slug|Invalid/u,
  );

  fetch.mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    assert.strictEqual(url.href, "https://api.github.com/app");
    assert.strictEqual(init?.method, "GET");
    const authorization = z.string().parse(new Headers(init?.headers).get("authorization"));
    assert.ok(authorization.startsWith("bearer ey"));
    const payload = authorization.split(".")[1];
    assert.ok(payload);

    const jwt = z
      .object({ iss: z.string() })
      .parse(JSON.parse(Buffer.from(payload, "base64url").toString()));

    assert.strictEqual(jwt.iss, process.env.GITHUB_APP_ID);

    return Promise.resolve(Response.json({ id: 5335315, slug: "Patchling-PR" }));
  });

  assert.strictEqual(await githubBotLogin(), "patchling-pr[bot]");
  assert.strictEqual(await githubBotLogin(), "patchling-pr[bot]");
  assert.lengthOf(fetch.mock.calls, 2);
});

test("repository token selection follows a changed App installation in a warm process", async () => {
  const { githubToken } = await import("../agent/lib/github.js");
  let installationId = 99;
  const tokenRequests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());

    if (url.pathname === "/repos/Acme/App/installation") {
      return Promise.resolve(Response.json({ id: installationId }));
    }

    tokenRequests.push(url.pathname);

    return Promise.resolve(
      Response.json({
        token: `token-${installationId}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
  });
  const call = { toolName: "getIssue", owner: "Acme", repo: "App" };
  assert.strictEqual(await githubToken(call), "token-99");
  installationId = 100;
  assert.strictEqual(await githubToken(call), "token-100");
  assert.deepEqual(tokenRequests, [
    "/app/installations/99/access_tokens",
    "/app/installations/100/access_tokens",
  ]);
});
