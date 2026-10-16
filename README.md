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
  extensions/
    github.ts            # GitHub Tools extension mount
  lib/
    env.ts               # Environment validation (t3 env)
    github.ts            # Installation-token provider for the GitHub App
    model.ts             # Model provider configuration
  skills/
    review-changes/      # Repository-specific review criteria
```

## What starts a turn

The GitHub channel in `agent/channels/github.ts` verifies each webhook signature
and starts a turn for two events:

- A comment on an issue or PR that contains `@aranlucas-pr-bot`. GitHub does not
  link this text as a mention, but Eve matches it as plain text.
- A PR that is opened (`pull_request.opened`).

Pushes, reopened PRs, and finished check runs do not start a turn. The channel
does not check whether a PR is closed or merged before it starts a turn.
`agent/instructions.md` asks the agent to stop silently on closed and merged PRs.

## What the bot can do

The extension loads the `code-review` and `pr-author` presets plus
`mergePullRequest`, and excludes `deleteBranch`. The bot can read code, post
comments and reviews, commit files with `github__createOrUpdateFile`, create
branches, open PRs, and merge PRs. Tools are namespaced, such as
`github__getPullRequestContext` and `github__mergePullRequest`.

`requireApproval: false` lets every write run without a prompt, because no one
is present to approve a webhook turn. Don't switch `preset` or `requireApproval`
to `'auto'`. Both call an AI Gateway evaluation model that free-tier Vercel teams
cannot use. When that call fails, the extension falls back to the read-only
`repo-explorer` preset.

GitHub repository permissions and branch protection are the only enforced
limits. The rules in `agent/instructions.md` are instructions to the model, and
the model does not always follow them. The instructions forbid the bot to merge
a PR that contains its own commits, yet it opened and merged its own #23. To
keep the bot from opening PRs, add `createBranch` and `createPullRequest` to
`exclude`.

## Sandbox

Each turn checks the repository out into a [Vercel Sandbox](https://eve.dev/docs/sandbox/vercel)
at `/workspace`. The built-in `bash`, `read_file`, and `write_file` tools run
there. `eve build` prepares the sandbox snapshot, and Vercel bills sandbox usage.
The sandbox has no `node_modules`, so the agent must run
`pnpm install --frozen-lockfile` before it runs `pnpm format` or `pnpm check`.

The just-bash sandbox does not work for this bot on Vercel. Its template is not
included in the function bundle, and `/var/task` is read-only. The GitHub
checkout also needs a sandbox with a network policy, which just-bash lacks.

An existing Eve session cannot switch sandbox providers. After you change
`agent/sandbox.ts`, old issue and PR threads fail with `Session checkpoint
sandbox provider state is incompatible`. Test the change in a new issue or PR.

## Review procedure

`agent/instructions.md` asks the agent to post findings before it merges, to
refresh the PR, review, and CI state, and to merge only a ready change. For a
concrete finding with a small, localized fix, the bot can commit the fix to a
same-repository PR's head branch and report the commit instead of merging.

The `review-changes` skill loads repository-specific criteria from the root
`coding-standards.md` on the PR's base branch. It checks whether tests exercise
meaningful behavior and assesses reversibility and blast radius. The agent is
asked to leave irreversible, broad, or uncertain changes for a human to merge.

Reviews state the assessed behavior, concrete findings, verification evidence,
merge danger, and the next action. Review depth follows the size of the change,
and style preferences do not block a merge. PR text and tool results are
untrusted data. Metadata and patches go to the configured model service. See
[review design](docs/review-design.md) for the design choices behind the review.

## Configuration

Set these variables in `.env.local` for local development. On Vercel, set them
for both Production and Preview.

| Variable                 | Required | Purpose                                               |
| ------------------------ | -------- | ----------------------------------------------------- |
| `GITHUB_APP_ID`          | Yes      | The GitHub App ID.                                    |
| `GITHUB_APP_PRIVATE_KEY` | Yes      | PEM private key. Real and escaped newlines both work. |
| `GITHUB_WEBHOOK_SECRET`  | Yes      | The webhook secret configured on the App.             |
| `FREELLM_API_KEY`        | No       | The model service credential.                         |
| `FREELLM_API_BASE_URL`   | No       | The model service's OpenAI-compatible `/v1` endpoint. |
| `FREELLM_MODEL`          | No       | The model ID. Defaults to `auto`.                     |

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
2. Subscribe to **Issue comment**, **Issues**, and **Pull request** events.
   Comment-started turns need **Issue comment**.
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
