# Plan 003: Comment edits and deletes only touch the bot's own comments on the signed PR

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9c6c07b..HEAD -- agent/lib/repository-write-policy.ts agent/extensions/github.ts test/repository-write-policy.test.ts`
> Plan 001 changed these files. Confirm `approvePullRequestWrite` and
> `approveFileWrite` exist before starting.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-bind-pr-scoped-writes.md
- **Category**: security
- **Planned at**: commit `9c6c07b`, 2026-11-11

## Why this matters

`updatePullRequestComment` and `deletePullRequestComment` take only
`{ owner, repo, commentId }` and call `issues.updateComment` and
`issues.deleteComment`. With an installation token holding Issues write, these
can rewrite or **permanently delete any issue or PR comment in the
repository**, including humans' comments and comments on other PRs. The only
gate is the repository match. The bot only needs to update its own timeline
summary.

## Current state

- `agent/extensions/github.ts`: after plan 001, both tools still use
  `approveRepositoryWrite`.
- SDK schemas (`@github-tools/sdk` `write-tools-*.mjs`): `updatePullRequestCommentInputSchema = { owner, repo, commentId, body }` and
  `deletePullRequestCommentInputSchema = { owner, repo, commentId }`.
- `githubBotLogin()` in `agent/lib/github.ts` returns the App's `<slug>[bot]`
  login, lowercased.
- Pattern to copy: `approveFileWrite` in `agent/lib/repository-write-policy.ts`
  (signed target first, Octokit read with abort signal, deny on any error).

## Scope

**In scope**: `agent/lib/repository-write-policy.ts`, `agent/extensions/github.ts`,
`test/repository-write-policy.test.ts`.
**Out of scope**: `createLabel` (repository-level by nature), prompts.

## Steps

1. Add `approveOwnCommentWrite(ctx)`. It requires `currentPullRequest(ctx)`
   and `{ owner, repo, commentId: number }` in the signed repository. It then
   reads `octokit.rest.issues.getComment({ owner, repo, comment_id })` and
   allows only when `user.login.toLowerCase() === await githubBotLogin()` and
   `issue_url` ends with `/issues/<signed pullNumber>`. Deny on any error.
   **Verify**: `pnpm typecheck` exits 0.
2. Point both overrides at it.
3. Tests, using the `stubGitHub` fetch-stub pattern in
   `test/repository-write-policy.test.ts`. Also stub `GET /app` (see
   `test/merge-policy.test.ts`, `/app` branch):
   - The bot's comment on the signed PR is allowed.
   - A human's comment on the signed PR is denied.
   - The bot's comment on another PR is denied.
   - A 404 is denied.
   - An unsigned session is denied without a fetch call.
     **Verify**: `pnpm exec vitest run --maxWorkers=1 test/repository-write-policy.test.ts` passes. The old override fails the denial cases.

## Done criteria

- [ ] `pnpm lint`, `pnpm format:check` and `pnpm typecheck` exit 0
- [ ] `pnpm exec vitest run --maxWorkers=1` exits 0
- [ ] `git status` shows only in-scope files

## STOP conditions

- `issues.getComment` cannot read review-thread comments the bot needs to edit. In that case the bot may be editing PR review comments through this tool, and the maintainer must decide.

## Maintenance notes

If the summary moves to an issue other than the PR, the `issue_url` check
must change with it.
