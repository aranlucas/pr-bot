# Plan 004: The bot never merges or queues fork heads or PRs from untrusted authors

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9c6c07b..HEAD -- agent/lib/merge-policy.ts test/merge-policy.test.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED. It changes which PRs the bot may merge. Dependabot PRs are already merged by `.github/workflows/dependabot-automerge.yml`, not by the bot.
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `9c6c07b`, 2026-11-11

## Why this matters

Automatic review runs on every opened or synchronized PR, from any author,
including forks (`agent/channels/github.ts:88-156`). Merge authority then
rests on the model's own assessment plus readiness gates. In a repository
with **no CI**, the CI gate passes vacuously:
`checkRuns.totalCount === 0` and `combinedStatus.totalCount === 0` both pass
in `agent/lib/merge-policy.ts:130-153`. So a stranger's PR that convinces the
model it is "localized/reversible/sufficient" is squash-merged with no human
involved. Prompt injection through PR text is the known risk here.
`agent/instructions.md` already treats forks as special for fixes ("Post
findings instead when the head is in a fork"), but the merge gate does not.

## Current state

- `agent/lib/merge-policy.ts:87-98` reads `getPullRequestContext` and `getIssue`.
  Neither SDK output includes the head repository or `author_association`.
- `agent/lib/merge-policy.ts:130-153`: the CI completeness and success checks,
  with no minimum-evidence requirement.
- Pattern for an SDK gap: `approveFileWrite` in
  `agent/lib/repository-write-policy.ts` reads `octokit.rest.pulls.get` for
  `head.repo.full_name`.

## Scope

**In scope**: `agent/lib/merge-policy.ts`, `test/merge-policy.test.ts`, and the
README "Review controls and merge authority" section.
**Out of scope**: comment-trigger authorization (plan 002), review publication
for non-approvals.

## Steps

1. In `approveMerge`, after the head-SHA check, read
   `octokit.rest.pulls.get`. Deny with "Merge blocked: fork heads need a human
   merge." when `head.repo?.full_name` is not the signed repository. Deny with
   "Merge blocked: the PR author is not a repository member or collaborator."
   unless `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`.
   Reuse the existing final `getPullRequest` re-read for freshness. Don't add a
   third read.
   **Verify**: `pnpm typecheck` exits 0.
2. Extend the `fixture()` PR object in `test/merge-policy.test.ts` with
   `head.repo.full_name: "policy/app"` and `author_association: "OWNER"` so
   existing cases still pass. Add cases: a fork head is denied, a `CONTRIBUTOR`
   author is denied, a `NONE` author is denied, and each denial also blocks
   `enable-auto-merge` (it calls `approveMerge`).
   **Verify**: `pnpm exec vitest run --maxWorkers=1 test/merge-policy.test.ts` passes.
3. Document the rule in the README merge-authority section.

## Open question for the maintainer

Should a repo with zero check runs and zero statuses be allowed to merge at
all? This plan does not change that. Record the decision in
`docs/review-design.md` either way.

## Done criteria

- [ ] `pnpm lint`, `pnpm format:check` and `pnpm typecheck` exit 0
- [ ] `pnpm exec vitest run --maxWorkers=1` exits 0
- [ ] `git status` shows only in-scope files

## STOP conditions

- The maintainer relies on the bot merging outside-contributor PRs. Check the
  installed repositories' merged-PR history if access allows, and stop if this
  is so.
- `pulls.get` in the merge path changes the request ordering that existing
  race tests assert (`reads` counter in `test/merge-policy.test.ts`). Do not
  rewrite those assertions; report.
