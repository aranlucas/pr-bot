import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { createGitHub } from "@/github";

interface PullResponse {
  readonly head: { readonly sha: string };
  readonly base: {
    readonly sha: string;
    readonly ref: string;
    readonly repo: { readonly default_branch: string };
  };
  readonly state: string;
  readonly merged: boolean;
  readonly draft: boolean;
  readonly mergeable: boolean;
  readonly mergeable_state: string;
  readonly title: string;
  readonly body: string;
  readonly user: { readonly login: string };
  readonly labels: readonly { readonly name: string }[];
  readonly changed_files: number;
}

interface ChecksResponse {
  readonly total_count: number;
  readonly check_runs: readonly {
    readonly name: string;
    readonly status: string;
    readonly conclusion: string;
  }[];
}

interface PermissionResponse {
  readonly permission: string;
}

type ApiResponse = PullResponse | ChecksResponse | PermissionResponse | readonly object[];

interface ClientOptions {
  readonly reviews?: readonly object[];
  readonly files?: readonly object[];
  readonly changedFiles?: number;
  readonly statuses?: readonly object[];
}

function client(options: ClientOptions = {}) {
  const calls: string[] = [];

  const github = createGitHub({
    token: "test",
    fetch: (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      const path = new URL(url).pathname;
      calls.push(path);
      let data: ApiResponse;

      if (path.endsWith("/pulls/42")) {
        data = {
          head: { sha: "head" },
          base: { sha: "base", ref: "main", repo: { default_branch: "main" } },
          state: "open",
          merged: false,
          draft: false,
          mergeable: true,
          mergeable_state: "clean",
          title: "Fix",
          body: "",
          user: { login: "author" },
          labels: [{ name: "agent:merge" }],
          changed_files: options.changedFiles ?? 1,
        };
      } else if (path.endsWith("/files")) {
        data = options.files ?? [
          {
            filename: "a.ts",
            status: "modified",
            patch: "@@ -1 +1 @@\n-old\n+new",
            additions: 1,
            deletions: 1,
          },
        ];
      } else if (path.endsWith("/check-runs")) {
        data = {
          total_count: 1,
          check_runs: [{ name: "test", status: "completed", conclusion: "success" }],
        };
      } else if (path.endsWith("/statuses")) {
        data = options.statuses ?? [];
      } else if (path.endsWith("/reviews")) {
        data = options.reviews ?? [];
      } else if (path.includes("/collaborators/")) {
        data = { permission: path.includes("/outsider/") ? "read" : "write" };
      } else {
        throw new Error(`Unexpected API route ${path}`);
      }

      const response = new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json" },
      });

      Object.defineProperty(response, "url", { value: url });

      return Promise.resolve(response);
    },
  });

  return { github, calls };
}

const target = { repository: "acme/app", number: 42, installationId: 99, delivery: "one" };

const review = (
  id: number,
  login: string,
  state = "APPROVED",
  commit_id = "head",
  type = "User",
) => ({ id, user: { login, type }, state, commit_id });

await test("only current-head, human, non-author write collaborators count as approvals", async () => {
  const f = client({
    reviews: [
      review(1, "author"),
      review(2, "old", "APPROVED", "old-head"),
      review(3, "bot", "APPROVED", "head", "Bot"),
      review(4, "outsider"),
      review(5, "maintainer"),
    ],
  });

  assert.deepEqual((await f.github.snapshot(target)).approvals, ["maintainer"]);
  assert.equal(f.calls.filter((path) => path.includes("/collaborators/")).length, 2);
});

await test("dismissed approvals are removed, comments do not replace a decision, and requests for changes remain blocking", async () => {
  const f = client({
    reviews: [
      review(1, "a"),
      review(2, "a", "DISMISSED"),
      review(3, "b", "CHANGES_REQUESTED"),
      review(4, "b", "COMMENTED"),
      review(5, "c"),
      review(6, "c", "COMMENTED"),
    ],
  });

  const pr = await f.github.snapshot(target);
  assert.deepEqual(pr.approvals, ["c"]);
  assert.equal(pr.changesRequested, true);
});

await test("latest decisive review replaces earlier changes requested", async () => {
  const f = client({ reviews: [review(2, "a"), review(1, "a", "CHANGES_REQUESTED")] });
  const pr = await f.github.snapshot(target);
  assert.deepEqual(pr.approvals, ["a"]);
  assert.equal(pr.changesRequested, false);
});

await test("latest status per context wins even if API data is out of order", async () => {
  const f = client({
    statuses: [
      { id: 1, context: "legacy", state: "failure" },
      { id: 3, context: "legacy", state: "success" },
      { id: 2, context: "other", state: "pending" },
    ],
  });

  assert.deepEqual((await f.github.snapshot(target)).checks, [
    { name: "legacy", success: true },
    { name: "other", success: false },
    { name: "test", success: true },
  ]);
});

await Promise.all(
  Object.entries({
    binary: { files: [{ filename: "image.png", status: "added", additions: 0, deletions: 0 }] },
    truncatedPatch: {
      files: [
        { filename: "a.ts", status: "modified", patch: "+one line", additions: 100, deletions: 0 },
      ],
    },
    truncatedFileList: { changedFiles: 101 },
  }).map(async ([name, options]) => {
    await test(`${name} is identified as an incomplete diff`, async () => {
      assert.equal((await client(options).github.snapshot(target)).completeDiff, false);
    });
  }),
);

await test("a full text patch is accepted as complete", async () => {
  assert.equal((await client().github.snapshot(target)).completeDiff, true);
});

await test("an App client requires a verified installation instead of falling back to a PAT", () => {
  assert.throws(() => createGitHub(), { message: "Verified GitHub App installation required" });
});

await test("Octokit exchanges the selected installation for a token before merging the exact SHA", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const calls: string[] = [];

  const github = createGitHub({
    appId: "123",
    installationId: 456,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const headers = new Headers(init?.headers);
      calls.push(url.pathname);

      if (url.pathname === "/app/installations/456/access_tokens") {
        assert.ok(headers.get("authorization")?.startsWith("bearer ey"));

        return Promise.resolve(
          Response.json({
            token: "installation-token",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: {},
            repository_selection: "all",
          }),
        );
      }

      assert.equal(url.pathname, "/repos/acme/app/pulls/42/merge");
      assert.equal(headers.get("authorization"), "token installation-token");
      assert.equal(init?.body, JSON.stringify({ sha: "reviewed-head", merge_method: "squash" }));

      return Promise.resolve(Response.json({ merged: true, sha: "merge-sha", message: "Merged" }));
    },
  });

  assert.equal(
    (await github.merge({ ...target, installationId: 456 }, "reviewed-head", "squash")).merged,
    true,
  );
  assert.deepEqual(calls, [
    "/app/installations/456/access_tokens",
    "/repos/acme/app/pulls/42/merge",
  ]);
});
