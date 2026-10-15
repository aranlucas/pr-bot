<img src="assets/icon.svg" width="64" height="64" alt="">

# PR Bot

An [Eve](https://eve.dev/docs) agent that reviews GitHub pull requests, posts
findings, and merges ready changes. Reviews and comments use
[@github-tools/eve-extension](https://github-tools.com/frameworks/eve-extension)
directly. A local tool squash merges only when GitHub still has the reviewed
head SHA. The main agent performs the review itself.

Source: [aranlucas/pr-bot](https://github.com/aranlucas/pr-bot).

## Development

Requires Node.js 24, pnpm 12, and Docker for Eve's default local sandbox template.

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
  tools/
    merge-reviewed-pull-request.ts # Squash merge with an atomic head SHA check
```

The extension uses the `code-review` preset and explicitly excludes its native
`mergePullRequest` tool. Review and comment tools are namespaced as
`github__getPullRequestContext`, `github__addPullRequestComment`, and so on.
`requireApproval: false` allows the bot to operate autonomously. GitHub enforces
repository permissions and branch protection.

The local `merge-reviewed-pull-request` tool requires the full reviewed head SHA
and supplies it to GitHub in the squash merge request. GitHub rejects a merge
when the current head differs from that SHA, including a push after the agent's
last refresh. The tool does not retry or substitute a newer SHA. This protects
the supplied commit identity; the review procedure still asks the agent to
review that commit, publish findings with its SHA, refresh PR/review/CI state,
and merge only when ready. It does not mechanically prove review quality or
completion.

## Configuration

Set these in `.env.local` locally and in the Vercel environment when hosted:

- `GITHUB_APP_ID`: the self-managed GitHub App ID.
- `GITHUB_APP_PRIVATE_KEY`: PEM private key. Real and escaped newlines work.
- `GITHUB_APP_SLUG`: the App slug.
- `GITHUB_WEBHOOK_SECRET`: the signing secret configured on the App.
- `FREELLM_API_KEY`: the model service credential.
- `FREELLM_API_BASE_URL`: the model service's OpenAI-compatible `/v1` endpoint.
- `FREELLM_MODEL`: model ID; defaults to `auto`.

The channel stores the webhook's installation ID in Eve session state at the
start of each turn. The extension's token provider uses that ID to mint a
short-lived GitHub App installation token on each call. No PAT or Vercel Connect
connector is needed. `@vercel/connect` is installed because the current extension
release imports it at module load, including in token-provider configurations.

The old `GITHUB_REPOSITORIES`, `BASE_BRANCH`, `REQUIRED_CHECKS`, `MIN_APPROVALS`,
`MERGE_METHOD`, `DRY_RUN`, and Redis variables are no longer used. Squash merging
is fixed in the local merge tool; enable it in the target repositories.

## Webhooks and reviews

Create a GitHub App with Contents and Pull requests read/write, Checks and Commit
statuses read, and the automatically included Metadata read. Install it on the
repositories the bot should manage. Point its webhook to
`https://YOUR-DEPLOYMENT/eve/v1/github` and subscribe to **Pull requests**,
**Check runs**, and **Check suites**.

The native Eve channel verifies webhook signatures and queues turns per PR.
Reviews run on PR opened, reopened, synchronize, ready-for-review, and edited
events, plus completed check runs and check suites with an associated PR.
Eve's native CI hooks target the first associated PR; events without PR
associations do not start a turn. Review/status events and commit-to-PR fallback
are not handled by a supplemental adapter.

The channel supplies the PR metadata and diff. Reviews use GitHub API tools and
skip sandbox checkout. The agent refreshes the PR context, posts its review with
the extension's native comment tool, and calls the local merge tool with the
reviewed SHA when ready.
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
