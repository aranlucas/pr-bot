import { createHmac, generateKeyPairSync } from "node:crypto";
import { test, expect } from "e2e";
import type { ChannelSendOptions, RouteHandlerArgs, Session } from "eve/channels";
import type { GitHubChannelState } from "eve/channels/github";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

process.env.GITHUB_APP_ID = "123";

process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });

process.env.GITHUB_WEBHOOK_SECRET = "fixture-secret";

process.env.FREELLM_API_KEY = "fixture-model-key";

process.env.SANDBOX_ENABLED = "false";

interface Delivery {
  address: string;
  options: ChannelSendOptions<GitHubChannelState>;
}

const channel = (await import("../agent/channels/github.js")).default;

function unexpected(): never {
  throw new Error("Unexpected fixture operation");
}

test("signed PR webhook delivers the reviewed head and suppresses already published reviews", async () => {
  const deliveries: Delivery[] = [];
  const pending: Promise<unknown>[] = [];
  let reviewed = false;

  const pr = {
    number: 7,
    state: "open",
    merged: false,
    draft: false,
    labels: [],
    head: { sha: "head" },
    base: { sha: "base" },
  };

  const files = [
    {
      filename: "app.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-old\n+fixed",
    },
  ];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;

    switch (path) {
      case "/app":
        return Promise.resolve(Response.json({ slug: "fixture-pr" }));
      case "/repos/Acme/App/installation":
        return Promise.resolve(Response.json({ id: 99 }));
      case "/app/installations/99/access_tokens":
        return Promise.resolve(
          Response.json({
            token: "fixture-token",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        );
      case "/repos/Acme/App/pulls/7":
        return Promise.resolve(Response.json(pr));
      case "/repos/Acme/App/pulls/7/reviews":
        return Promise.resolve(
          Response.json(
            reviewed
              ? [
                  {
                    user: { login: "fixture-pr[bot]" },
                    commit_id: "head",
                    state: "COMMENTED",
                    submitted_at: "2026-11-06T00:00:00Z",
                  },
                ]
              : [],
          ),
        );
      case "/repos/Acme/App/pulls/7/files":
        return Promise.resolve(Response.json(files));
      case "/repos/Acme/App/compare/base...head":
        return Promise.resolve(Response.json({ files }));
      default:
        throw new Error(`Unexpected GitHub fixture request: ${path}`);
    }
  };

  const args: RouteHandlerArgs<GitHubChannelState> = {
    from: (address) => ({
      create: unexpected,
      send: (_message, options) => {
        deliveries.push({ address, options });

        const session: Session = {
          id: "fixture-session",
          send: unexpected,
          respond: unexpected,
          cancel: unexpected,
          compact: unexpected,
          clear: unexpected,
          reset: unexpected,
          getEventStream: unexpected,
          getStreamTailIndex: unexpected,
        };

        return Promise.resolve(session);
      },
      respond: unexpected,
      cancel: unexpected,
      compact: unexpected,
      clear: unexpected,
      reset: unexpected,
    }),
    resolveSession: unexpected,
    attachSession: unexpected,
    to: unexpected,
    params: {},
    waitUntil: (task) => {
      pending.push(task);
    },
    requestIp: null,
    describe: unexpected,
    listSkillFiles: unexpected,
    readSkill: unexpected,
    invokeTool: unexpected,
  };

  const route =
    channel.routes.find((candidate) => candidate.transport !== "websocket") ?? unexpected();

  const body = JSON.stringify({
    action: "synchronize",
    pull_request: pr,
    repository: { id: 123, full_name: "Acme/App", name: "App", owner: { login: "Acme" } },
    installation: { id: 99 },
    sender: { id: 10, login: "author", type: "User" },
  });

  async function dispatch(secret: string) {
    const response = await route.handler(
      new Request("https://fixture.test/eve/v1/github", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": "fixture-delivery",
          "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
      }),
      args,
    );

    await Promise.all(pending.splice(0));

    return response;
  }

  try {
    expect((await dispatch("forged")).status).toBe(401);
    expect(deliveries).toHaveLength(0);
    expect((await dispatch("fixture-secret")).status).toBe(200);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].address).toBe("repo:123:pull:7");
    expect(deliveries[0].options.auth?.attributes?.installation_id).toBe("99");
    expect(deliveries[0].options.context?.some((entry) => entry.includes("+fixed"))).toBe(true);
    reviewed = true;
    expect((await dispatch("fixture-secret")).status).toBe(200);
    expect(deliveries).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
