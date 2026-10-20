<img src="assets/icon.svg" width="64" height="64" alt="">

# PR Bot

An [Eve](https://eve.dev/docs) agent that reviews GitHub pull requests, posts
findings, and merges ready changes. It runs as a GitHub App on Vercel and uses
[@github-tools/eve-extension](https://github-tools.com/frameworks/eve-extension)
for every GitHub operation. The main agent performs the review itself.

Source: [aranlucas/pr-bot](https://github.com/aranlucas/pr-bot).

## Development

You need Node.js 24 and pnpm 12.

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
# Fill in the GitHub App and model credentials.
pnpm dev
```

Eve loads `.env.local` and listens on port 2000. Interactive sessions are
disabled, so GitHub webhooks start every turn.

Oxforge supplies the shared Oxlint and Oxfmt policies. Husky runs lint-staged,
type checking, and tests before each commit. GitHub Actions runs the same checks.

`@aranlucas/kit-skills` supplies the local development skills. `pnpm install`
links the approved package version into `.agents/skills` and `.claude/skills`,
and pnpm keeps those generated links out of Git. When you upgrade the package,
also update its exact version in `permissions` in `pnpm-workspace.yaml`.

## Testing

Run `pnpm test` for the Vitest suite. Use `pnpm check` for lint, format,
typecheck, and tests together. Run `pnpm build` to confirm that `eve build`
compiles the agent and prepares the sandbox snapshot.

## Agent structure

The layout follows the
[Eve PR triage template](https://github.com/vercel-labs/eve-pr-triage-agent-template).
Shared code lives under `agent/lib/` and is imported as `@/<module>`.

```text
agent/
  agent.ts               # Model, context window, and built-in tools
  instructions.md        # Review, fix, and merge procedure
  sandbox.ts             # Vercel Sandbox environment
  channels/
    eve.ts               # Health and API surface; interactive sessions disabled
    github.ts            # Signed GitHub App webhook channel
  connections/
    context7.ts          # Library API discovery and version-specific docs
    freellm.ts           # Public web search through FreeLLMAPI MCP
  extensions/
    github.ts            # GitHub Tools extension mount
  instrumentation/
    runtime.ts           # Metadata-only lifecycle logs
  hooks/
    release-sandbox.ts   # Stop sandbox compute while the agent is idle
  lib/
    env.ts               # Environment validation (t3 env)
    github.ts            # Installation-token provider for the GitHub App
    model.ts             # Model provider configuration
  skills/
    review-changes/      # Repository-specific review criteria
    review-follow-up/    # Questions, corrections, verification, and review controls
```

## What starts a turn

The GitHub channel in `agent/channels/github.ts` verifies each webhook signature
and starts a turn for these events:

- A comment on an issue or PR that contains `@aranlucas-pr-bot`. GitHub does not
  link this text as a mention, but Eve matches it as plain text.
- An open, non-draft PR that is opened, reopened, marked ready for review, or
  updated with new commits (`opened`, `reopened`, `ready_for_review`, `synchronize`).

Automatic PR events skip payloads that are draft, closed, merged, or labeled
`pr-bot:paused`. Finished check runs do not start a turn. Mentions still start
turns while paused. The instructions refresh the current PR and labels because
an event can become stale before the turn runs; closed and merged PRs end silently.
The channel suppresses automatic assistant-message replies on PR timelines and
review threads. Review comments use the explicit GitHub extension tools, so a
final response explaining a silent exit is kept off the PR. Issue conversations
still receive assistant replies.

## What the bot can do

The extension loads the `code-review` preset plus `createOrUpdateFile`,
`mergePullRequest`, timeline-comment reads, issue-label reads, and label controls.
It excludes branch and PR creation, branch deletion, and `resolveReviewThread`.
The bot can read code, post comments and reviews, commit localized fixes, and
merge eligible PRs. Tools are namespaced, such as
`github__getPullRequestContext` and `github__mergePullRequest`.

The installed `resolveReviewThread` tool accepts only a thread ID. This app's
token provider needs `owner` and `repo` to select an installation, so that tool
is excluded until the extension can carry repository context for it. The bot can
verify a fix and reply in its review thread; authors resolve the conversation.

`requireApproval: false` lets writes run without a prompt, because no one
is present to approve a webhook turn. The merge override uses a deterministic
approval predicate that either permits or denies the call without a prompt.
Don't switch `preset` or `requireApproval`
to `'auto'`. Both call an AI Gateway evaluation model that free-tier Vercel teams
cannot use. When that call fails, the extension falls back to the read-only
`repo-explorer` preset.

An `overrides` entry narrows `github__addPullRequestComment` to the bot's single
timeline summary. After a successful post, the model sees only the comment ID and
an instruction to change it with `github__updatePullRequestComment`. A model once
repeated a successful call and posted the same summary twice. The extension
cannot cap calls per turn, and an approval gate would park the webhook turn, so
this reduces the repeat without preventing it.

The event filters, suppression of automatic PR assistant replies, capability
exclusions, and merge readiness gate run in code. Review judgments, pause/resume
commands, incremental-review deduplication, and freshness before comments or
fixes remain instructions to the model. GitHub permissions and branch protection
also constrain writes. The bot once opened and merged its own #23 despite an
instruction forbidding self-merges; branch and PR creation are now unavailable,
and the merge gate checks commit authorship independently of the model.

### Merge eligibility

`record-merge-assessment` records a typed review judgment in Eve's durable
session state: reviewed SHA, coverage, unresolved findings, reversibility,
blast radius, verification, review-only intent, and rationale. It returns
`eligible`, `human_review_required`, or `waiting_for_evidence`. Reviews publish
that status and rationale in the existing PR summary. This local capability is
custom because the GitHub extension has no tool for recording review judgment;
all GitHub operations still use the extension's executor.

The native merge tool's approval predicate requires an eligible assessment from
the same turn, policy version, and current signed webhook's PR. It then reads
fresh PR state, labels, reviews, checks, statuses, and the base-to-head commit
comparison. It permits only squash merges and denies paused, stale, closed,
merged, draft, conflicting, unknown, or unready changes and PRs containing this
bot's commits. Incomplete readiness or authorship results and failed reads deny
the merge. An old change request is cleared by that reviewer's later approval
or dismissal, not by a later comment. Successful, neutral, and skipped check
runs pass; pending and failed checks do not. No configured CI signals alone
does not block a merge; GitHub still enforces required checks and approvals.

This separates review quality from merge readiness. The semantic assessment
and publication of its summary still depend on the model's judgment and
instructions. The native merge tool has no head-SHA precondition; the gate
rechecks the head after gathering evidence, but the subsequent merge is not
atomic. No learned risk score or incident-history database is introduced.

## Sandbox

Reviews use GitHub extension tools by default, without starting sandbox compute.
Set `SANDBOX_ENABLED=true` to enable Eve's optional default tools, including
`bash`, `read_file`, and `write_file`, and check the repository out into a
[Vercel Sandbox](https://eve.dev/docs/sandbox/vercel) at `/workspace` before
each turn. The flag accepts only `true` or `false` and defaults to `false`.
GitHub tools, skills, and MCP connections remain available in either mode.
Disabled mode also removes Eve's optional `agent` and `web_fetch` tools; reviews
use the configured search connection and CI evidence instead of local commands.
With sandbox use disabled, the GitHub channel acknowledges the turn with an
eyes reaction and skips checkout; the idle hook skips sandbox access as well.

When enabled, `agent/hooks/release-sandbox.ts` stops sandbox compute as a session
becomes idle. The persistent filesystem remains available for a later turn.
The sandbox has no `node_modules`, so the agent must run
`pnpm install --frozen-lockfile` before it runs `pnpm format` or `pnpm check`.

The flag controls runtime use, not build preparation. `eve build` still prepares
the Vercel sandbox snapshot, and Vercel bills sandbox usage. The same provider
stays configured in both modes so toggling the flag does not switch existing
sessions to an incompatible provider. Existing runs stay on their deployment;
use the same flag value at build and runtime and redeploy after changing it.
Separately inspect old idle sandboxes when reclaiming capacity; this flag does
not stop previously running sandboxes.

The just-bash sandbox does not work for this bot on Vercel. Its template is not
included in the function bundle, and `/var/task` is read-only. The GitHub
checkout also needs a sandbox with a network policy, which just-bash lacks.

An existing Eve session cannot switch sandbox providers. After you change
`agent/sandbox.ts`, old issue and PR threads fail with `Session checkpoint
sandbox provider state is incompatible`. Test the change in a new issue or PR.

If a build fails preparing a snapshot with `429 Concurrency limit exceeded`,
the build needs a free Vercel Sandbox slot. Inspect the project's running
sandboxes and their `sessionId` tags, match those to Agent Runs, and stop
compute for sessions confirmed to be idle before retrying `pnpm build`.
Active reviews and other concurrent builds also consume slots. The idle cleanup
hook only applies to runs on the deployment containing it; older runs need
separate inspection. Keep sandbox preparation enabled for deployment:
`--skip-sandbox-prewarm` produces compile-check output without guaranteeing
the snapshot required by production.

## Review procedure

Mention the bot with the outcome you need:

- “Explain this finding” or “that's intentional; reconsider” keeps the response
  in the existing review thread and rechecks the evidence.
- “I fixed it; verify” checks the latest head against the original failure case
  and reports whether it is fixed, remains, or needs specific evidence.
- “Review only” publishes a review without committing or merging in that turn.
- “Fix this finding” follows the existing localized-fix policy.
- “Pause reviews” adds `pr-bot:paused`; “resume reviews” removes only that label.
  Resume enables the next supported PR event. A manual review while paused is
  review-only. Labels remain visible and can also be managed directly on GitHub.

Questions and verification requests end after the requested answer; they do not
start a fix or merge. The bot reads prior summaries and review threads when
reviewing updates, keeps one timeline summary, batches new inline findings, and
is instructed to avoid repeating unchanged feedback. Review history stays in
GitHub rather than a separate database. A freshness read narrows the race with
concurrent changes but cannot make the subsequent GitHub write atomic.

`agent/instructions.md` asks the agent to post findings before it merges, to
refresh the PR, review, and CI state, and to merge only a ready change. For a
concrete finding with a small, localized fix, the bot can commit the fix to a
same-repository PR's head branch and report the commit instead of merging.

The `review-changes` skill loads repository-specific criteria from the root
`coding-standards.md` on the PR's base branch. It checks whether tests exercise
meaningful behavior, looks for custom logic covered by existing library APIs,
and assesses reversibility and blast radius. Reuse suggestions identify a
verified API compatible with the resolved dependency version and stay
nonblocking unless the custom code has a concrete defect. The agent is asked to
leave irreversible, broad, or uncertain changes for a human to merge.

The native Eve MCP connection exposes Context7's `resolve-library-id` and
`query-docs` tools. Reviews use them to discover existing APIs and check library
assumptions, then follow unresolved implementation questions into source and
tests with GitHub read tools when accessible. Queries contain library questions,
without private repository code or credentials. A failed lookup is a review
limitation only when it leaves a specific material risk unresolved.
Set `CONTEXT7_API_KEY` for documentation lookups; a missing key leaves the rest
of the bot available and returns an error when the connection is used.

The FreeLLMAPI MCP connection exposes only `freellm__web_search` for public
documentation, release notes, and upstream issues beyond Context7. Eve discovers
the server's tool schema and sends `FREELLM_API_KEY` as a Bearer token; the model
never receives the credential. Routing controls, cache writes, diagnostics, and
model delegation tools are excluded. Queries contain public library questions,
without private code, PR text, or credentials. Results provide source URLs and
short extracts, and the bot cites sources for claims supported by search.

Enable **MCP server** under **Keys → Agent compatibility** in the FreeLLMAPI
dashboard. Configure at least one search provider key and enable its engine under
**Models → Search**. Search uses those providers' quotas separately from model
tokens. Search reuses `FREELLM_API_KEY` and connects to `/mcp` on
`FREELLM_API_BASE_URL`'s origin; no additional environment variables are needed.
FreeLLMAPI requires the `initialize` handshake, so protocol discovery is disabled
for this connection. Disabled MCP or unavailable search providers surface as
lookup errors when search is used. A missing API key fails environment validation
at startup.
The same search service is also available through `POST /v1/search`; the bot
uses Eve's native MCP connection instead of a custom HTTP tool.

Reviews state the assessed behavior, concrete findings, verification evidence,
merge danger, and the next action. Review depth follows the size of the change,
and style preferences do not block a merge. PR text and tool results are
untrusted data. Metadata and patches go to the configured model service. See
[review design](docs/review-design.md) for the design choices behind the review.

## Configuration

Set these variables in `.env.local` for local development. On Vercel, set them
for both Production and Preview.

| Variable                 | Required | Purpose                                                                  |
| ------------------------ | -------- | ------------------------------------------------------------------------ |
| `GITHUB_APP_ID`          | Yes      | The GitHub App ID.                                                       |
| `GITHUB_APP_PRIVATE_KEY` | Yes      | PEM private key. Real and escaped newlines both work.                    |
| `GITHUB_WEBHOOK_SECRET`  | Yes      | The webhook secret configured on the App.                                |
| `FREELLM_API_KEY`        | Yes      | The model and search service credential.                                 |
| `FREELLM_API_BASE_URL`   | No       | The model service's OpenAI-compatible `/v1` endpoint.                    |
| `FREELLM_MODEL`          | No       | The model ID. Defaults to `auto`.                                        |
| `CONTEXT7_API_KEY`       | No       | Context7 API key for library documentation lookups.                      |
| `SANDBOX_ENABLED`        | No       | Enable runtime checkout and optional default tools. Defaults to `false`. |

`agent/lib/env.ts` validates these variables with t3 env when the agent loads,
which includes `eve build`. A missing required variable fails the build.
`SKIP_ENV_VALIDATION=1` skips validation, but it also skips the defaults, so the
build then fails on the undefined `FREELLM_MODEL`.

`agent/lib/github.ts` mints a short-lived installation token for every GitHub
call. The extension passes the call's `owner` and `repo` to the token provider,
which looks up the App's installation on that repository with
`GET /repos/{owner}/{repo}/installation` and caches the ID. The bot therefore
works on every repository where the App is installed. A call with no target
repository, such as an unscoped search, fails with an error that names the tool.

`agent/agent.ts` sets `modelContextWindowTokens: 64_000`. AI Gateway has no
context-window data for the custom `freellmapi` model, and `eve build` fails
without it. Eve uses the value to decide when to compact a session.

Eve 0.80.1 has no public setting to disable model or workflow retries. Its
framework defaults remain enabled, even when the LLM API also retries.

`agent/lib/model.ts` gives each provider call a 90-second total deadline,
including streamed response bodies, and preserves Eve's cancellation signal.
That leaves time for compaction, tools, and failure reporting before the
deployment's 300-second function limit. Eve's default ten-minute output timeout
exceeds that limit. The deadline bounds the wait; it does not repair a slow
provider or guarantee that a review completes.

### Model request headers

PR Bot sends its identity on streaming requests and on every tool-loop step:

- `User-Agent`: `pr-bot (Eve agent; OpenAI-compatible)`, when the SDK keeps it.
- `HTTP-Referer`: `https://github.com/aranlucas/pr-bot`, the stable app URL.
- `X-OpenRouter-Title` and the legacy `X-Title`: `PR Bot`.

The SDK can replace `User-Agent`, including during tool loops. The attribution
headers stay in place.
[OpenRouter app attribution](https://openrouter.ai/docs/app-attribution) needs
the app URL and shows the title as the app name.

Attribution works when you call OpenRouter directly. When requests go through
FreeLLMAPI, the proxy must pass the attribution headers on. The
[upstream OpenRouter adapter](https://github.com/tashfeenahmed/freellmapi/blob/main/server/src/providers/index.ts)
sets its own `FreeLLMAPI` title and a localhost referer. A change in this app
cannot fix attribution past that proxy. FreeLLMAPI's Recent calls table groups
requests by the user agent that reaches it, so requests can appear under an SDK
identity or `unknown`.

## Set up the GitHub App

1. Create a GitHub App with these repository permissions: Contents, Issues, and
   Pull requests read and write. Checks and Commit statuses read. Metadata read
   is included automatically.
2. Subscribe to **Issue comment**, **Pull request review comment**, **Issues**,
   and **Pull request** events. Timeline mentions need **Issue comment**;
   inline finding replies need **Pull request review comment**.
3. Set the webhook URL to `https://YOUR-DEPLOYMENT/eve/v1/github`. The root path
   returns 404 for webhooks.
4. Install the App on the repositories the bot manages.

After you add a permission or an event, open
[your installations](https://github.com/settings/installations), select
**Configure** next to the App, and accept the new permissions. GitHub does not
deliver the new events until you accept.

## Deploy

```sh
pnpm exec eve link --project pr-bot --non-interactive
# Set the environment variables in Vercel.
pnpm exec eve deploy
```

Use Node.js 24. If Deployment Protection applies, allow GitHub webhook access and
keep signature verification on.

## Test a deployment

1. Check that `https://YOUR-DEPLOYMENT/eve/v1/health` returns `{"ok":true}`.
2. Send a request with a bad signature to `/eve/v1/github`. Expect a 401.
3. Comment `@aranlucas-pr-bot` and a short request on a test issue. Expect a reply
   in the thread.
4. Read the runtime logs. A 200 from the webhook only means GitHub delivered the
   event. Agent turns run in the workflow function
   (`/.well-known/workflow/v1/flow`), so sandbox and tool errors appear there.

Every preview deploy gets a new URL. To keep one webhook URL across deploys,
point a fixed alias at each new preview:

```sh
vercel alias set <preview-url> pr-bot-preview-aranlucas.vercel.app
```

## Debug a review run

`agent/instrumentation/runtime.ts` uses Eve's
[lifecycle instrumentation](https://eve.dev/docs/observability/instrumentation)
to write JSON lines with `source: "pr-bot.runtime"`. Logs include session,
turn, step, attempt, and operation IDs. Model calls report elapsed time, finish
reason, and token usage. Tool calls report their names, elapsed time, outcomes,
and framework error codes when available. Failures and returned tool errors go
to stderr; other events go to stdout.

Find the review's session ID in Vercel's Agent Runs view or CLI, then search
runtime logs for that ID. Pass an explicit project and team because worktrees
may have no local Vercel link:

```sh
vercel agent-runs list --project pr-bot --scope aranlucas-projects --since 1h --json
vercel logs --project pr-bot --scope aranlucas-projects --since 30m --query 'pr-bot.runtime' --json
vercel logs --project pr-bot --scope aranlucas-projects --since 30m --query '<session-id>' --json
```

Use `operationId` to match a start with its completion or failure. A model
start without a terminal event identifies an unfinished provider call; a tool
start identifies an unfinished tool call. A step failure followed by a higher
`attemptIndex` identifies a retry. `input.requested` records whether the agent
is waiting on a question, approval, or session limit. `session.waiting` is
resumable; `session.completed` and `session.failed` are terminal. A completed
review-posting tool call is evidence that the tool finished; confirm the review
on GitHub before treating the review as delivered. Log lines may repeat during
durable replay, so they are not a reliable count of executions.

The runtime log provider explicitly disables input and output capture for
every audience. It never logs prompts, review text, tool arguments or results,
raw errors, or credentials. Failure details are limited to available framework
error codes. These logs do not enable full Agent Runs transcripts or change
Eve's OpenTelemetry capture and Workflow retention policies. Existing runs
remain on their original deployment and will not gain the new logs.

Eve exports to Agent Runs on Vercel by default. Its
[Agent Runs guide](https://eve.dev/docs/observability/agent-runs) explains the
separate Vercel sampling requirement: existing projects need a matching tracing
sampling rule. Lifecycle logs do not depend on Agent Runs trace visibility.
