import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { ChannelSendOptions, RouteHandlerArgs, Session } from "eve/channels";
import type { GitHubChannelState } from "eve/channels/github";
import { createReviewChannel } from "@/github-channel";

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
  process.env.GITHUB_REPOSITORIES = "acme/*";
  process.env.GITHUB_WEBHOOK_SECRET = "secret";

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

  const channel = createReviewChannel({
    credentials: { webhookSecret: "secret", installationToken: "test", appSlug: "pr-bot" },
    api: {
      fetch: (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());

        return Promise.resolve(
          Response.json(
            url.pathname.includes("/compare/")
              ? { files: [] }
              : {
                  number: 7,
                  title: "Fix",
                  head: { sha: "head" },
                  base: { sha: "base" },
                },
          ),
        );
      },
    },
  });

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

await test("Eve's native PR channel dispatches an unlabeled PR with its verified installation", async () => {
  const f = fixture();

  const response = await f.dispatch(
    "pull_request",
    JSON.stringify({
      ...envelope,
      action: "opened",
      pull_request: { number: 7, head: { sha: "head" }, base: { sha: "base" } },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].address, "repo:123:pull:7");
  assert.deepEqual(f.deliveries[0].options.auth, {
    authenticator: "github-app",
    principalType: "service",
    principalId: "acme/app",
    attributes: { repository: "acme/app", number: "7", delivery: "delivery", installationId: "99" },
  });
});

await test("completed checks reach every associated PR through Eve's native receive hook", async () => {
  const f = fixture();

  const response = await f.dispatch(
    "check_run",
    JSON.stringify({
      ...envelope,
      action: "completed",
      check_run: { head_sha: "head", pull_requests: [{ number: 7 }, { number: 8 }, { number: 7 }] },
    }),
  );

  assert.equal(response.status, 202);
  assert.deepEqual(
    f.deliveries.map((d) => d.address),
    ["repo:123:pull:7", "repo:123:pull:8"],
  );
  assert.ok(f.deliveries.every((d) => d.options.state.installationId === 99));
});

await test("approval changes use the same PR session as native PR events", async () => {
  const f = fixture();

  const response = await f.dispatch(
    "pull_request_review",
    JSON.stringify({ ...envelope, action: "submitted", pull_request: { number: 7 } }),
  );

  assert.equal(response.status, 202);
  assert.equal(f.deliveries[0].address, "repo:123:pull:7");
});

await Promise.all(
  ["pull_request", "check_run"].map(async (name) => {
    await test(`${name} rejects a forged signature before dispatch`, async () => {
      const f = fixture();
      const response = await f.dispatch(name, JSON.stringify(envelope), "forged");
      assert.equal(response.status, 401);
      assert.equal(f.deliveries.length, 0);
    });
  }),
);

await test("repository webhooks without an App installation cannot start a review", async () => {
  const f = fixture();

  const response = await f.dispatch(
    "pull_request_review",
    JSON.stringify({ repository, action: "submitted", pull_request: { number: 7 } }),
  );

  assert.equal(response.status, 400);
  assert.equal(f.deliveries.length, 0);
});

await test("uninstalled owners cannot bypass the repository allowlist", async () => {
  const f = fixture();

  const response = await f.dispatch(
    "check_run",
    JSON.stringify({
      ...envelope,
      repository: { ...repository, full_name: "other/app" },
      action: "completed",
      check_run: { head_sha: "head", pull_requests: [{ number: 7 }] },
    }),
  );

  assert.equal(response.status, 403);
  assert.equal(f.deliveries.length, 0);
});

await test("native PR events require an installation and an allowed repository", async () => {
  const f = fixture();
  const pull_request = { number: 7, head: { sha: "head" }, base: { sha: "base" } };
  await f.dispatch(
    "pull_request",
    JSON.stringify({ repository, sender: envelope.sender, action: "opened", pull_request }),
  );
  await f.dispatch(
    "pull_request",
    JSON.stringify({
      ...envelope,
      repository: { ...repository, full_name: "other/app" },
      action: "opened",
      pull_request,
    }),
  );
  assert.equal(f.deliveries.length, 0);
});
