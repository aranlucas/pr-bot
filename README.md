<img src="assets/icon.svg" width="64" height="64" alt="">

# PR Bot

An [Eve](https://eve.dev/docs) agent that reviews GitHub pull requests, posts
findings, commits localized fixes, and merges eligible changes. It runs as a
GitHub App on Vercel. Repository metadata and patches go to the configured model
service; public documentation searches must exclude private code and PR text.

## Development

Use Node.js 24 and pnpm 12:

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
# Fill in the GitHub App and model credentials.
pnpm dev
```

Eve loads `.env.local` and listens on port 2000. Interactive sessions are
disabled; signed GitHub webhooks start turns.

Run `pnpm test` for Vitest or `pnpm check` for lint, formatting, type checking,
and tests. Husky runs lint-staged, type checking, and tests before commits;
GitHub Actions checks the same areas. Fixture tests disable Octokit's notification
throttle because their responses are synthetic; production throttling stays on.

`pnpm build` compiles the agent and prepares its Vercel Sandbox snapshot, even
when runtime sandbox use is disabled. It evaluates environment validation and
needs configuration. A build with `--skip-sandbox-prewarm` is only a compile
check, not proof that the production snapshot is ready.

`@aranlucas/kit-skills` links development skills into `.agents/skills` and
`.claude/skills` during install. Keep its exact permission version in
`pnpm-workspace.yaml` aligned when upgrading it.

## Agent structure

The layout follows the
[Eve PR triage template](https://github.com/vercel-labs/eve-pr-triage-agent-template).
Start with [standing instructions](agent/instructions.md),
[review criteria](agent/skills/review-changes/SKILL.md), and
[follow-up controls](agent/skills/review-follow-up/SKILL.md).
[Repository standards](coding-standards.md) apply to changes here; the bot reads
the target PR's standards from its base branch.

The [GitHub channel](agent/channels/github.ts) handles ingress,
[extension configuration](agent/extensions/github.ts) selects capabilities, and
[merge](agent/lib/merge-policy.ts) and [review](agent/lib/review-policy.ts)
policies enforce write gates. Signed webhook targets and review controls live in
[GitHub context](agent/lib/github-context.ts); durable review judgment and its
current-turn validity live in [merge assessment](agent/lib/merge-assessment.ts).
Shared helpers live in `agent/lib/`, imported as
`@/<module>`. See [review design](docs/review-design.md) for rationale,
[the roadmap](ROADMAP.md) for proposed product work, and
[reliability work](docs/reliability-research.md) for unresolved validation.

## What starts a turn

- A comment on an issue or PR containing `@aranlucas-pr-bot`. This is a plain-text
  invocation alias, independent of the App's actual account slug.
- An open, non-draft PR opened, reopened, marked ready, or updated with commits
  (`opened`, `reopened`, `ready_for_review`, `synchronize`).

Automatic events skip `pr-bot:paused`, stale heads, and heads with a submitted
approval, comment review, or change request from this App. Pending and dismissed
reviews do not suppress a review. Failed freshness, identity, or review-history
reads prevent automatic dispatch. This is not a lock against simultaneous events
arriving before publication. Explicit mentions can reassess the same head and
work while paused, but mentions on draft, closed, or merged PRs are filtered.
Completed check runs do not start turns or retry blocked merges.

PR output uses explicit GitHub tools; automatic assistant-message delivery is
suppressed on PR timelines and review threads to avoid replies after a silent
exit. Issue conversations still receive assistant replies.

## Review controls and merge authority

Mention the bot with the outcome you need:

| Request                         | Result                                                                     |
| ------------------------------- | -------------------------------------------------------------------------- |
| Explain or reconsider a finding | Rechecks evidence and answers in the existing thread.                      |
| “I fixed it; verify”            | Reports fixed, still open, or missing evidence at the latest head.         |
| “Review only”                   | Reviews without committing or merging in that turn.                        |
| “Fix this finding”              | Verifies and applies a small permitted fix; never merges in the same turn. |
| “Pause reviews”                 | Cancels GitHub auto-merge before applying `pr-bot:paused`.                 |
| “Resume reviews”                | Removes only that label; the next supported event can trigger review.      |

Questions and verification requests do not authorize fixes or merges. Manual
reviews while paused are review-only. Applying the pause label directly blocks
new bot merge attempts but **does not cancel an existing GitHub auto-merge
request**; disable that on GitHub as well. Authors resolve review conversations:
the installed thread-resolution tool lacks the repository context needed by
this App's installation-token provider.

The bot is instructed to maintain one timeline summary and reconcile prior
findings. Summary deduplication and freshness before comments, replies, and fixes
still depend on the model. Formal review publication has a deterministic
current-turn assessment and freshness gate, but the SDK lacks review `commit_id`
binding, so its read and subsequent write are not atomic.

Direct squash merges require an eligible assessment of the current head,
complete readiness evidence, and no bot-authored commits. The request pins the
reviewed SHA, so a later push makes GitHub reject it. Failed or ambiguous writes
require fresh state and reassessment before retrying. The bot cannot create
branches or PRs, and a human must review and merge PRs containing its commits.

Pending CI permits a clean approval and GitHub auto-merge queueing when other
evidence suffices; it never permits an immediate merge. Queueing requires:

- **Allow auto-merge** in the repository.
- A branch protection rule requiring at least one approval and **Dismiss stale
  pull request approvals when new commits are pushed**. Rulesets alone are not
  recognized by this gate.
- The App excluded from bypass lists.

GitHub owns the wait after queueing. New commits require fresh approval, which
may come from a human; queueing does not rerun the bot's semantic assessment at
merge time. A blocked result names the reason and leaves merging to a human.
The bot does not poll for CI. Repository permissions and branch protection
remain authoritative at merge time.

## Configuration

Use [.env.example](.env.example) for variable names and local defaults; the
[environment schema](agent/lib/env.ts) defines required values. Set deployment
variables for both Production and Preview. `SENTRY_DSN` enables optional
metadata-only failure reporting. Real or escaped newlines work in the App's PEM
key. Environment validation also runs during builds;
`SKIP_ENV_VALIDATION=1` skips defaults as well and is not a complete build setup.

Set `CONTEXT7_API_KEY` for library documentation lookups. Its absence fails the
lookup, not startup. For FreeLLMAPI web search, enable **MCP server** under
**Keys → Agent compatibility**, configure a search provider key, and enable its
engine under **Models → Search**. Search uses a separate provider quota and
connects to `/mcp` on `FREELLM_API_BASE_URL`'s origin using `FREELLM_API_KEY`.
Protocol discovery is disabled because this server requires the initialize
handshake. Only public search is exposed, not router controls or delegation.

Set FreeLLMAPI's **Min context window** floor to **128k** before deploying the
agent's 131,072-token window. Change the routing floor and app window together;
a higher floor reduces the available model pool. `auto` does not guarantee a
particular upstream model or independently available fallback. The app requests
low reasoning, but the router and provider must forward and honor it. The
[reliability notes](docs/reliability-research.md#model-routing-and-invocation-budget)
record an observed forwarding gap and the validation needed before tuning.

Installation tokens are selected per target repository. Unscoped GitHub calls
without `owner` and `repo` fail. Account checks use authenticated `GET /app`, not
the mention alias. Only successful App identity reads are cached; restart the
process after changing the App slug.

Keep extension `preset` and `requireApproval` explicit. Their `'auto'` modes
invoke an AI Gateway evaluator unavailable to free-tier Vercel teams; failure
falls back to the read-only preset. Webhook turns have no person present to
answer an approval prompt. See [capability rationale](docs/review-design.md#capability-boundaries)
before changing these settings.

Model requests carry the app's GitHub URL and `PR Bot` attribution headers.
The SDK may replace `User-Agent`; a proxy must forward the attribution headers
for [OpenRouter attribution](https://openrouter.ai/docs/app-attribution) to work.
This app cannot correct a proxy that substitutes its own identity.

## Sandbox

`SANDBOX_ENABLED=false` is the default: reviews use GitHub tools without checkout
or Eve's optional shell/file, `agent`, and `web_fetch` tools. Skills and MCP
connections remain available. Setting it to `true` enables checkout at
`/workspace` in a [Vercel Sandbox](https://eve.dev/docs/sandbox/vercel).
Install dependencies there before running repository checks. The idle hook stops
compute while preserving the filesystem for a later turn.

The flag controls runtime use, not build snapshot preparation or billing. Use
the same value at build and runtime and redeploy after changing it. It does not
stop older running sandboxes. The provider stays configured in either mode:
existing sessions cannot switch sandbox providers. After a provider change,
`Session checkpoint sandbox provider state is incompatible` requires testing in
a new issue or PR. Just-bash cannot replace Vercel Sandbox here: checkout needs
a network policy, and the Vercel function filesystem cannot host its template.

For `429 Concurrency limit exceeded` during snapshot preparation, inspect running
sandboxes and their `sessionId` tags, match them to Agent Runs, and stop compute
only for sessions confirmed idle before retrying the build. Active reviews and
concurrent builds also need slots; older deployments may lack the current idle hook.

## Set up the GitHub App

1. Grant repository **Contents**, **Issues**, and **Pull requests** read/write;
   **Checks** and **Commit statuses** read. Metadata read is automatic.
2. Subscribe to **Issue comment**, **Pull request review comment**, **Issues**,
   and **Pull request** events. Timeline mentions use Issue comment; finding
   replies use Pull request review comment.
3. Set the webhook URL to `https://YOUR-DEPLOYMENT/eve/v1/github`.
   The root path returns 404 for webhooks.
4. Install the App on the repositories it manages.

After adding permissions or events, accept the changes under
[your installations](https://github.com/settings/installations) → **Configure**.
Keep signature verification enabled and allow GitHub webhooks through any
Deployment Protection.

## Deploy and smoke-test

```sh
pnpm exec eve link --project pr-bot --non-interactive
# Set the environment variables in Vercel. Use Node.js 24.
pnpm exec eve deploy
```

Check `/eve/v1/health` for `{"ok":true}`, verify a bad signature at
`/eve/v1/github` receives 401, then mention the bot on a disposable issue and
confirm the reply. A webhook 200 confirms delivery to the route, not a completed
turn; inspect the workflow function (`/.well-known/workflow/v1/flow`) and GitHub
output too.

Preview URLs change on every deployment. A fixed alias can keep the webhook URL
stable:

```sh
vercel alias set <preview-url> pr-bot-preview-aranlucas.vercel.app
```

## Debug a review run

Use the session ID from Vercel Agent Runs to correlate structured logs. Pass the
project and team explicitly because worktrees may lack a Vercel link:

```sh
vercel agent-runs list --project pr-bot --scope aranlucas-projects --since 1h --json
vercel logs --project pr-bot --scope aranlucas-projects --since 30m --query 'pr-bot.runtime' --json
vercel logs --project pr-bot --scope aranlucas-projects --since 30m --query '<session-id>' --json
```

`pr-bot.runtime` records operation IDs, session/turn/step/attempt coordinates,
model identity, timings, usage, tool names, and safe failure codes. Search JSON
content: Vercel can index stderr JSON as `info` independently of embedded
`level`. `policy_denial` is informational; recovered attempt failures differ
from failed turns. A GitHub SDK `{ error: ... }` result emits `tool.result.failed`
even when the executor completed. Confirm publication on GitHub rather than
inferring it from a completed tool trace.

`pr-bot.model-stream` records parsed-stream timing and character counts without
content. Its fresh `callId` identifies a physical provider invocation, not a
replay-stable operation. Use request and response IDs to correlate it with
lifecycle logs. A missing settled record may mean a host kill; `completed` means
the SDK finished the stream, not that a review was delivered. Waiting sessions
can contain completed turns, and durable replay can repeat log lines.

Runtime logs and Sentry exclude prompts, review text, tool arguments/results,
raw errors, and credentials. Sentry deduplicates by operation/event identity and
excludes cancellation and policy denials. This privacy contract does not change
Eve's separate OpenTelemetry capture or Workflow retention. Agent Runs trace
visibility additionally needs Vercel's tracing sampling configuration; lifecycle
logs do not. See [Agent Runs](https://eve.dev/docs/observability/agent-runs).

For deadline failures, missing deployments, or replay recovery, follow the
[reliability notes](docs/reliability-research.md). Verify the serving release:
active work stays on its deployment; a later delivery can hand an idle session
to a new one.

The CI `protocol` job uses `e2e@0.23.0`'s supported engine-less runner for
signed-webhook routing and completed-review suppression with fixture HTTP
responses. It needs no browser, model key or production credentials. Run it
with `pnpm test:e2e` when local validation is permitted. The CI `build` job
compiles with disposable credentials and skips sandbox prewarming; it does not
validate deployment or production sandbox provisioning. Extension writes are
restricted to the signed webhook's repository; cross-repository reads remain
available. Repository installation discovery is refreshed for token selection,
while Octokit retains responsibility for caching installation tokens.
