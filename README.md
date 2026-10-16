<img src="assets/icon.svg" width="64" height="64" alt="">

# PR Bot

An [Eve](https://eve.dev/docs) agent that reviews GitHub pull requests, posts
findings, and merges ready changes using
[@github-tools/eve-extension](https://github-tools.com/frameworks/eve-extension)
directly. The main agent performs the review itself.

Source: [aranlucas/pr-bot](https://github.com/aranlucas/pr-bot).

## Development

Requires Node.js 24 and pnpm 12. The agent uses Eve's just-bash sandbox (pure
JavaScript, no Docker or Vercel Sandbox usage), since reviews go through the
GitHub API instead of a checkout.

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
# Fill in the GitHub App and model credentials.
pnpm dev
```

Eve loads `.env.local` and listens on port 2000 by default. Interactive sessions
are disabled; GitHub webhooks start reviews.

```sh
pnpm check
pnpm build
```

Oxforge supplies the shared Oxlint and Oxfmt policies. Husky runs lint-staged,
type checking, and tests before commits. GitHub Actions runs the Vitest suite, type checking,
linting, and formatting checks.

`@aranlucas/kit-skills` supplies the local development skills. `pnpm install`
links the approved package version into `.agents/skills` and `.claude/skills`;
pnpm ignores its generated links in Git. When upgrading the package, review and
update its exact version in `permissions` in `pnpm-workspace.yaml` as well.

## Agent structure

The layout follows the
[Eve PR triage template](https://github.com/vercel-labs/eve-pr-triage-agent-template),
with `@/<module>` imports for shared code under `agent/lib/`:

```text
agent/
  agent.ts               # Model and capability configuration
  instructions.md        # Review and merge procedure
  channels/
    eve.ts               # Health/API surface; interactive sessions disabled
    github.ts            # Native signed GitHub App webhook channel
  extensions/
    github.ts            # Direct GitHub Tools extension mount
  lib/
    github.ts            # Installation-token provider for the self-managed App
    model.ts             # Model provider configuration
  sandbox.ts             # just-bash sandbox (no Docker or Vercel Sandbox)
```

The extension uses the `code-review` and `pr-author` presets plus
`mergePullRequest`, excluding `createBranch`, `deleteBranch`, and
`createPullRequest`. Tools are
namespaced as `github__getPullRequestContext`, `github__addPullRequestComment`,
`github__createOrUpdateFile`, `github__mergePullRequest`, and so on.
`requireApproval: false` allows the bot to
operate autonomously. GitHub enforces repository permissions and branch protection.

There are no custom comment or merge tools, Redis locks, review receipts, review
fingerprints, repository allowlists, or application-level dry-run checks. The
review procedure lives in `agent/instructions.md` and the extension executes the
GitHub operations. It asks the agent to post findings before merging, refresh
PR/review/CI state, and merge only when the change is ready. Reviews are published
only while the PR is open. The agent stops silently for closed or merged PRs and
ends immediately after a merge attempt without posting a merge confirmation.

For a concrete finding with a small, localized fix, the bot can commit the fix
to a same-repository PR's head branch with `github__createOrUpdateFile`. It then
reports the fix commits in its review and does not merge. The bot never merges
a PR that contains its own commits; a human reviews and merges those. A turn
started by the bot's own commit reviews it without pushing another fix.

The `review-changes` skill loads repository-specific criteria from the root
`coding-standards.md` on the PR's base branch, checks whether tests exercise
meaningful behavior, and assesses reversibility and blast radius. Automatic
merging is reserved for reversible, localized changes. Irreversible changes,
broad material impact, and materially uncertain merge danger are left for a
human to review and merge. These are agent instructions; GitHub branch
protection remains the enforced merge boundary.

Reviews include the assessed behavior, concrete findings, verification evidence,
merge danger, and the next action. A confirmed process gap can produce one
specific prevention suggestion for a later check or standards update.
See [review design](docs/review-design.md) for the source talk, design choices,
and the complementary role of Shipshape's practice catalog.

## Configuration

Set these in `.env.local` locally and in the Vercel environment when hosted:

- `GITHUB_APP_ID`: the self-managed GitHub App ID.
- `GITHUB_APP_PRIVATE_KEY`: PEM private key. Real and escaped newlines work.
- `GITHUB_APP_SLUG`: the App slug.
- `GITHUB_WEBHOOK_SECRET`: the signing secret configured on the App.
- `FREELLM_API_KEY`: the model service credential.
- `FREELLM_API_BASE_URL`: the model service's OpenAI-compatible `/v1` endpoint.
- `FREELLM_MODEL`: model ID; defaults to `auto`.

Model requests send PR Bot's identity on streaming requests and every tool-loop
step:

- `User-Agent`: `pr-bot (Eve agent; OpenAI-compatible)` when the SDK retains it.
- `HTTP-Referer`: `https://github.com/aranlucas/pr-bot`, the stable app URL.
- `X-OpenRouter-Title` and legacy `X-Title`: `PR Bot`.

All headers use the provider's `headers` field. The SDK can replace `User-Agent`,
including during tool loops; the attribution headers remain available.

[OpenRouter app attribution](https://openrouter.ai/docs/app-attribution) requires
the app URL and uses the title as its display name; `User-Agent` alone does not
attribute usage.
These headers work when calling OpenRouter directly through the configured
OpenAI-compatible endpoint. When routing through FreeLLMAPI, its proxy must
preserve the attribution headers for OpenRouter to credit PR Bot. The
[upstream OpenRouter adapter](https://github.com/tashfeenahmed/freellmapi/blob/main/server/src/providers/index.ts)
currently supplies its own `FreeLLMAPI` title and localhost referer, so changing
this app alone cannot fix attribution beyond that proxy.

FreeLLMAPI's Recent calls table and agent chart use the user agent that reaches
the proxy when client logging is enabled. If the SDK replaces it, requests can
appear under an SDK identity or `unknown`. The upstream classifier has no
dedicated PR Bot category.

The channel stores the webhook's installation ID in Eve session state at the
start of each turn. The extension's token provider uses that ID to mint a
short-lived GitHub App installation token on each call. No PAT or Vercel Connect
connector is needed. `@vercel/connect` is installed because the current extension
release imports it at module load, including in token-provider configurations.

The old `GITHUB_REPOSITORIES`, `BASE_BRANCH`, `REQUIRED_CHECKS`, `MIN_APPROVALS`,
`MERGE_METHOD`, `DRY_RUN`, and Redis variables are no longer used. Squash merging
is specified in the agent instructions; enable it in the target repositories.

## Webhooks and reviews

Create a GitHub App with Contents and Pull requests read/write, Checks and Commit
statuses read, and the automatically included Metadata read. Install it on the
repositories the bot should manage. Point its webhook to
`https://YOUR-DEPLOYMENT/eve/v1/github` and subscribe to **Pull requests**,
**Check runs**, and **Check suites**.

The native Eve channel verifies webhook signatures and queues turns per PR.
Reviews run on PR opened, reopened, synchronize, ready-for-review, and edited
events, plus completed check runs and check suites with an associated PR.
Before dispatching, the channel fetches the current PR state and ignores closed
or merged PRs, including delayed events whose payload still describes an open PR.
Eve's native CI hooks target the first associated PR; events without PR
associations do not start a turn. Review/status events and commit-to-PR fallback
are not handled by a supplemental adapter.

The channel supplies the PR metadata and diff. Reviews use GitHub API tools and
skip sandbox checkout. The agent refreshes the PR context, posts its review with
the extension's native comment tool, and uses the native merge tool when ready.
High-risk changes stay open for a human to merge; approval alone does not lift
the bot's risk gate, and review events do not start a new turn.
The channel does not also publish the final assistant message, avoiding a second
copy of the review. Framework failure messages still appear in the PR thread.

Review depth is proportional to the change. Low-risk documentation, typo, and
formatting edits can pass without runtime tests or unrelated file inspection.
Findings need concrete patch evidence and consequences; speculative improvements
and style preferences do not block merging. PR text and tool results are
untrusted data. Metadata and patches are sent to the configured model service.

## Deployment

```sh
pnpm exec eve link --project pr-bot --non-interactive
# Set environment variables in Vercel.
pnpm exec eve deploy
```

Use `pnpm build` and Node.js 24. If Deployment Protection applies, configure
GitHub webhook access while retaining signature verification.

Verify the deployment's `/eve/v1/health` route, a signed GitHub ping, and a draft
PR review. Check Eve Agent Runs and server logs for failed processing; webhook
acknowledgement does not mean a review was completed.
