# Plan 001: PR-scoped extension writes only reach the signed PR and its same-repository head branch

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9c6c07b..HEAD -- agent/lib/repository-write-policy.ts agent/extensions/github.ts test/repository-write-policy.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW. Writes the bot already makes on the current PR stay allowed. Only off-target writes are newly denied.
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `9c6c07b`, 2026-11-11
- **Outcome**: implemented in the same PR as this plan.

## Why this matters

PR Bot commits "localized fixes" with the GitHub Tools `createOrUpdateFile`
tool. That tool's `branch` input is optional and **defaults to the
repository's default branch**. The only gate is that `owner/repo` matches the
signed webhook repository. So one model mistake (an omitted branch), or a PR
body or patch that talks the model into another branch, commits directly to
`main`. For a fork PR whose head ref is named `main`, writing "to the head
branch" in the base repository also lands on `main`. Labels, PR edits,
summaries, replies, and reviewer requests take a PR or issue number that was
never compared with the signed PR. The repo's own audit lists this as an
open limit, not a decision: `docs/reliability-audit.md` F2 says "Comment IDs
and file branches still require model judgment … this change does not claim
to bind every write to a particular PR or branch."

## Current state

- `agent/lib/repository-write-policy.ts:11-25`: the only write predicate.
  It compares `toolInput.owner/repo` with the signed `attributes.repository`:
  ```ts
  export function approveRepositoryWrite(ctx: ApprovalContext): ApprovalStatus {
    const signed = invocation.safeParse(ctx.session.auth.current);
    const input = repository.safeParse(ctx.toolInput);
    if (
      !signed.success ||
      !input.success ||
      `${input.data.owner}/${input.data.repo}`.toLowerCase() !==
        signed.data.attributes.repository.toLowerCase()
    ) {
      return { type: "denied", reason: "Write blocked: target the signed webhook's repository." };
    }
    return "not-applicable";
  }
  ```
- `agent/extensions/github.ts:30-48`: every enabled write uses `approveRepositoryWrite`.
- SDK schema (`node_modules/@github-tools/sdk/dist/write-tools-*.mjs`, `createOrUpdateFileInputSchema`):
  `branch: z.string().optional().describe("Branch to commit to (defaults to the default branch)")`.
  The SDK `getPullRequest` output has `branch` (head ref) but **no head repository**.
- Exemplars to match:
  - The signed PR target comes from `currentPullRequest(ctx)`, and comparison is `samePullRequest(a, b)` in `agent/lib/github-context.ts`. Use them; don't parse auth again.
  - The fresh-read gate pattern is `agent/lib/review-policy.ts:40-72`: `ctx.abortSignal.throwIfAborted()`, read GitHub, re-check abort, deny with a reason, and wrap the whole thing in `try { … } catch { return denied }`.
  - SDK gaps are filled with the SDK's public client `createOctokit(await githubToken({ toolName, owner, repo }))`, plus a comment naming the missing SDK field (see `agent/channels/github.ts:117-125`).

## Commands you will need

| Purpose   | Command                                                                                                                                                                                                                                                                                    | Expected on success |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| Install   | `pnpm install --frozen-lockfile`                                                                                                                                                                                                                                                           | exit 0              |
| Typecheck | `pnpm typecheck`                                                                                                                                                                                                                                                                           | exit 0              |
| One test  | `pnpm exec vitest run --maxWorkers=1 test/repository-write-policy.test.ts`                                                                                                                                                                                                                 | all pass            |
| All tests | `pnpm exec vitest run --maxWorkers=1`                                                                                                                                                                                                                                                      | all pass            |
| Lint      | `pnpm lint`                                                                                                                                                                                                                                                                                | exit 0              |
| Format    | `pnpm format:check`                                                                                                                                                                                                                                                                        | exit 0              |
| Build     | CI `build` job command: disposable `GITHUB_APP_ID=123 GITHUB_WEBHOOK_SECRET=fixture-secret FREELLM_API_KEY=fixture-model-key SANDBOX_ENABLED=false GITHUB_APP_PRIVATE_KEY="$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null)" pnpm build --skip-sandbox-prewarm` | exit 0              |

## Scope

**In scope**: `agent/lib/repository-write-policy.ts`, `agent/extensions/github.ts`,
`test/repository-write-policy.test.ts`, and the two doc sentences in
`README.md` ("Extension writes are restricted…") and `docs/review-design.md`
("File fixes use…").

**Out of scope**: `updatePullRequestComment` / `deletePullRequestComment`.
They take only a comment ID, so binding them needs a comment read (plan 003).
`createLabel` is repository-level by nature. Also out of scope: merge and
review policies, and the prompts in `agent/instructions.md`, which already tell
the model to use the head branch.

## Steps

### Step 1: Add `approvePullRequestWrite`

In `repository-write-policy.ts`, add a predicate that accepts either
`{ owner, repo, pullNumber }` or `{ owner, repo, issueNumber }` (a zod union
whose issue branch maps `issueNumber` to `pullNumber`). It allows the write
only when `currentPullRequest(ctx)` exists and `samePullRequest(target, input)`.
Issue-only conversations have no signed PR, so they are denied.

**Verify**: `pnpm typecheck` gives exit 0.

### Step 2: Add `approveFileWrite`

Make this an async predicate:

1. Deny without network access if there is no signed PR, `branch` is missing
   or empty, or `owner/repo` is not the signed repository.
2. Read the PR with `octokit.rest.pulls.get` (pass the abort signal).
3. Deny when `state !== "open"`, when `head.repo` is null or its `full_name`
   is not the signed repository (case-insensitive), or when `head.ref !== branch`.
4. Deny on any thrown error.

**Verify**: `pnpm typecheck` gives exit 0.

### Step 3: Wire the overrides

In `agent/extensions/github.ts`:

- `createOrUpdateFile` uses `approveFileWrite`.
- `addLabels`, `removeLabel`, `updatePullRequest`, `addPullRequestComment`,
  `replyToReviewComment` and `requestReviewers` use `approvePullRequestWrite`.
- `createLabel`, `updatePullRequestComment` and `deletePullRequestComment`
  keep `approveRepositoryWrite`.

**Verify**: `pnpm exec vitest run --maxWorkers=1 test/github-extension.test.ts` passes. It calls `execute` directly, so approvals don't apply.

### Step 4: Tests (see Test plan), then docs

**Verify**: the full gate list in Done criteria.

## Test plan

In `test/repository-write-policy.test.ts`, resolve the mounted tools through
`github.events["step.started"]` (keep the existing pattern) and call each tool's
`approval` with a signed `ApprovalContext`.

- Repository-level tools: same repository allowed. Other owner, other repo,
  and an unsigned session are denied.
- Each PR-number tool and each issue-number tool: the signed PR is allowed, and
  so is a `review_thread` on it. Another PR in the same repository, the same
  number in another repository, an issue conversation, and an unsigned session
  are denied.
- `createOrUpdateFile`, with a `fetch` stub for `/repos/Acme/App/installation`,
  `/app/installations/31/access_tokens` and `/repos/Acme/App/pulls/7` (copy the
  stub shape from `test/merge-policy.test.ts:198-245`):
  - The head branch is allowed, and the test asserts the PR was read.
  - An omitted or empty branch is denied with no fetch call.
  - The base branch is denied, and so is another same-repo branch.
  - A fork head with the same ref name is denied.
  - A deleted head repository (`head.repo: null`) is denied.
  - A closed PR is denied.
  - A 404 PR read is denied. Use 404, not 5xx: Octokit retries 5xx and the test
    times out.
  - Another repository, an issue conversation, and an unsigned session are
    denied with no fetch call.
- Baseline proof: restore the two `agent/` files from `9c6c07b` and rerun the
  file. The denial cases must fail. Then restore the fix.

## Done criteria

- [ ] `pnpm lint`, `pnpm format:check` and `pnpm typecheck` each exit 0
- [ ] `pnpm exec vitest run --maxWorkers=1` exits 0, and `test/repository-write-policy.test.ts` has 60 tests
- [ ] Against the `9c6c07b` policy, the new denial cases fail
- [ ] The CI `build` job command (disposable credentials, `--skip-sandbox-prewarm`) exits 0
- [ ] `git status` shows only in-scope files

## STOP conditions

- The SDK `createOrUpdateFile` schema no longer has an optional `branch`, or
  `pulls.get` no longer returns `head.repo.full_name`.
- An existing test outside the in-scope file starts failing because a write it
  exercises through `approval` now targets another PR. This would mean a real
  flow depends on cross-PR writes, and the maintainer must decide.

## Maintenance notes

- If the bot ever legitimately needs to write to another PR (for example,
  cross-linking), add a narrowly named tool. Don't loosen this predicate.
- A same-repository PR whose head ref _is_ the default branch (for example,
  `main` into `release`) still permits writes to `main`, because that branch is
  the PR's content. Review this if such PRs are common.
- The head-SHA race remains. The read binds the branch, not the commit the bot
  reviewed. `createOrUpdateFile`'s file `sha` still guards content.
