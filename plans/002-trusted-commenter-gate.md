# Plan 002: Only trusted repository members can start a turn by mentioning the bot

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 9c6c07b..HEAD -- agent/channels/github.ts test/github-channel.test.ts README.md`
> On a mismatch with the excerpts below, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED. Outside contributors can no longer ask the bot questions by mention. That is a product change; see the open question.
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `9c6c07b`, 2026-11-11

## Why this matters

`aranlucas/pr-bot` is public, and the bot is meant for installation on owned
repositories, some of them public (for example `aranlucas/shipshape-mcp`). Any
GitHub account can comment `@aranlucas-pr-bot …` on a PR or issue and start a
model turn. The review controls in `README.md` (`Resume reviews`, `Fix this
finding`, review requests that can end in approval and merge) have no
commenter check. A drive-by user can remove a maintainer's `pr-bot:paused`
label, request bot commits on someone else's PR, or spend model quota on
demand. Eve's default filter only drops Bot accounts and the App's own comments.

## Current state

- `agent/channels/github.ts:63-87`: `onComment` checks only the mention regex
  and, for PRs, that the PR is open, unmerged and not a draft. It then returns
  `{ auth: defaultGitHubAuth(ctx) }`.
- Eve `0.82.0` `dist/src/public/channels/github/dispatch.js`,
  `isIgnoredInboundComment`, ignores comments containing `<!-- eve:github:`,
  authors with `type === "Bot"`, and `<botName>[bot]`. It does not check
  repository permission.
- `comment.raw` is the GitHub webhook comment object. It includes
  `author_association` (`OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`,
  `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN`, `NONE`) for both
  `issue_comment` and `pull_request_review_comment`.
- Convention: raw webhook shapes are parsed with small zod schemas at the top
  of `agent/channels/github.ts` (see `automaticReview`). Match that.
- Test pattern: `test/github-channel.test.ts` sends signed webhooks through the
  native channel. See "a mention can request a review on a paused PR" (~line 573) for a mention fixture.

## Commands you will need

| Purpose   | Command                                                                 | Expected |
| --------- | ----------------------------------------------------------------------- | -------- |
| Typecheck | `pnpm typecheck`                                                        | exit 0   |
| Tests     | `pnpm exec vitest run --maxWorkers=1 test/github-channel.test.ts`       | all pass |
| All       | `pnpm lint && pnpm format:check && pnpm exec vitest run --maxWorkers=1` | exit 0   |

## Scope

**In scope**: `agent/channels/github.ts`, `test/github-channel.test.ts`, and
the README section "What starts a turn".
**Out of scope**: automatic PR events (plan 004), the Eve dependency, and the
prompts.

## Steps

### Step 1: Gate `onComment` on `author_association`

Add `const trustedCommenter = z.object({ author_association: z.enum(["OWNER", "MEMBER", "COLLABORATOR"]) });`.
In `onComment`, after the mention check and before the PR read, return `null`
unless `trustedCommenter.safeParse(comment.raw).success`. Doing the check
first also avoids a GitHub read for ignored comments.

**Verify**: `pnpm typecheck` exits 0.

### Step 2: Tests

Extend `test/github-channel.test.ts`:

- `OWNER`, `MEMBER` and `COLLABORATOR` mentions dispatch (assert the delivered
  turn, as the existing mention tests do).
- `CONTRIBUTOR`, `NONE` and a missing `author_association` do not dispatch,
  and no `GET /repos/.../pulls/N` request is made.
- The existing mention fixtures must carry `author_association: "OWNER"`. Add
  it to the fixture builder rather than to each test.

**Verify**: the channel test file passes. Restoring the old `onComment` makes
the negative cases fail.

### Step 3: Document

In README "What starts a turn", state that mentions are accepted only from
owners, organization members and collaborators. Say that private org
membership can make GitHub report `CONTRIBUTOR`, in which case the person
must be a collaborator or make their membership public.

## Open question for the maintainer (do not resolve in code)

Should the PR's own author (often `CONTRIBUTOR`) be allowed to ask "explain"
or "verify"? If yes, route it as review-only with no label or file writes.
That needs deterministic enforcement, such as an auth attribute that
`approvePullRequestWrite` / `approveFileWrite` read, and it is a larger
change. The default in this plan is to deny.

## Done criteria

- [ ] `pnpm lint`, `pnpm format:check` and `pnpm typecheck` exit 0
- [ ] `pnpm exec vitest run --maxWorkers=1` exits 0, with the new trusted and untrusted cases
- [ ] `git status` shows only in-scope files

## STOP conditions

- `comment.raw` in the Eve version in use lacks `author_association`.
- An existing e2e fixture (`e2e/github-webhook.e2e.ts`) breaks in a way that
  needs more than adding `author_association` to its payload.

## Maintenance notes

`author_association` comes from the signed payload, so it costs no extra API
call. If finer control is needed later (for example "write permission"), use
`GET /repos/{owner}/{repo}/collaborators/{user}/permission` and keep the deny
default.
