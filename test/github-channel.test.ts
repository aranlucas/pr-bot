import { createHmac, generateKeyPairSync } from "node:crypto";
import { assert, beforeEach, describe, test, vi } from "vitest";
import type { ChannelSendOptions, RouteHandlerArgs, Session } from "eve/channels";
import type { GitHubChannelState } from "eve/channels/github";
import channel from "../agent/channels/github.js";

interface Delivery {
  readonly address: string;
  readonly options: ChannelSendOptions<GitHubChannelState>;
}

const repository = { id: 123, full_name: "Acme/App", name: "App", owner: { login: "Acme" } };

const envelope = {
  repository,
  installation: { id: 99 },
  sender: { id: 10, login: "author", type: "User" },
};

function unexpected(): never {
  throw new Error("Unexpected fixture operation");
}

function fixture() {
  const deliveries: Delivery[] = [];
  const pending: Promise<unknown>[] = [];

  const session: Session = {
    id: "session",
    send: unexpected,
    respond: unexpected,
    cancel: unexpected,
    compact: unexpected,
    clear: unexpected,
    reset: unexpected,
    getEventStream: unexpected,
    getStreamTailIndex: unexpected,
  };

  const args: RouteHandlerArgs<GitHubChannelState> = {
    from: (address) => ({
      send: (_message, options) => {
        deliveries.push({ address, options });

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

  async function dispatch(name: string, body: string, secret = "secret") {
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

    const response = await route.handler(
      new Request("https://example.com/eve/v1/github", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-github-event": name,
          "x-github-delivery": "delivery",
          "x-hub-signature-256": signature,
        },
      }),
      args,
    );

    await Promise.all(pending);

    return response;
  }

  return { dispatch, deliveries };
}

describe("native GitHub webhook integration", () => {
  beforeEach(() => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    vi.stubEnv("GITHUB_APP_ID", "123");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey.export({ type: "pkcs8", format: "pem" }));
    vi.stubEnv("GITHUB_APP_SLUG", "pr-bot");
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "secret");

    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;

      if (path.includes("/access_tokens")) {
        return Promise.resolve(
          Response.json({
            token: "installation-token",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        );
      }

      return Promise.resolve(
        Response.json(
          path.includes("/compare/")
            ? { files: [] }
            : {
                number: 7,
                title: "Fix",
                head: { sha: "head" },
                base: { sha: "base" },
              },
        ),
      );
    });
  });

  test("the native signed webhook channel dispatches a PR with App installation context", async () => {
    const f = fixture();

    const response = await f.dispatch(
      "pull_request",
      JSON.stringify({
        ...envelope,
        action: "opened",
        pull_request: { number: 7, head: { sha: "head" }, base: { sha: "base" } },
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.strictEqual(f.deliveries.length, 1);
    assert.strictEqual(f.deliveries[0].address, "repo:123:pull:7");
    assert.strictEqual(f.deliveries[0].options.auth?.authenticator, "github-webhook");
    assert.strictEqual(f.deliveries[0].options.auth?.attributes?.installation_id, "99");
    assert.strictEqual(f.deliveries[0].options.state.installationId, 99);
  });

  test("native CI hooks dispatch the first associated PR and ignore checks without associations", async () => {
    const f = fixture();

    const check = {
      id: 1,
      head_sha: "head",
      status: "completed",
      conclusion: "success",
      app: { id: 2, slug: "github-actions" },
    };

    const response = await f.dispatch(
      "check_run",
      JSON.stringify({
        ...envelope,
        action: "completed",
        check_run: { ...check, pull_requests: [{ number: 7 }, { number: 8 }] },
      }),
    );

    assert.strictEqual(response.status, 200);
    assert.deepEqual(
      f.deliveries.map((delivery) => delivery.address),
      ["repo:123:pull:7"],
    );
    await f.dispatch(
      "check_run",
      JSON.stringify({
        ...envelope,
        action: "completed",
        check_run: { ...check, pull_requests: [] },
      }),
    );
    assert.strictEqual(f.deliveries.length, 1);
  });

  test("the native channel rejects forged webhook signatures", async () => {
    const f = fixture();
    const response = await f.dispatch("pull_request", JSON.stringify(envelope), "forged");
    assert.strictEqual(response.status, 401);
    assert.strictEqual(f.deliveries.length, 0);
  });
});
