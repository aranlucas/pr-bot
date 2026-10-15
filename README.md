<img src="assets/icon.svg" width="64" height="64" alt="">

# PR Bot

A [Vercel Eve](https://eve.dev/docs) agent that reviews GitHub pull requests through
[OpenRouter's free-model router](https://openrouter.ai/openrouter/free) and merges
changes that pass both the review and deterministic GitHub checks.

Production health: [pr-bot-kohl.vercel.app](https://pr-bot-kohl.vercel.app/eve/v1/health).
Source: [aranlucas/pr-bot](https://github.com/aranlucas/pr-bot).

## Development

Requires Node.js 24, pnpm 12, and Docker for Eve's default local sandbox template.

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
# Fill in credentials and repository settings.
pnpm dev
```

Eve loads `.env.local` in development and listens on port 2000 by default.
Interactive sessions are disabled; signed webhook service principals start reviews.

```sh
pnpm check
pnpm build
```

Oxforge supplies the shared type-aware Oxlint and Oxfmt policies. Use `pnpm lint`,
`pnpm lint:fix`, `pnpm format`, and `pnpm format:check`. Husky runs lint-staged,
type checking, and tests before each commit. GitHub Actions uses `pnpm/setup@v3`
to install Node, the pinned pnpm version, and dependencies in one step.

## Configuration

Set variables in `.env.local` locally and the Vercel Production environment when hosted:

- `OPENROUTER_API_KEY`: dedicated OpenRouter API key. PR metadata and patches are
  sent to OpenRouter and the routed provider. Review that provider's data policy
  before connecting repositories containing sensitive material.
- `OPENROUTER_MODEL`: defaults to `openrouter/free`. Only that router or an explicit
  `:free` model is accepted. Requests also cap provider prompt and completion
  prices at zero. There is no paid-model fallback. Free-provider availability,
  context windows, and rate limits can cause a review to fail or wait.
- `GITHUB_TOKEN`: token that can read private Checks API results and merge PRs.
  The installed credential is a dedicated classic PAT with only the `repo` scope,
  expiring November 14, 2026. The fine-grained tokens tested during setup returned
  `403` for private check runs. Use credentials without branch-rule exemptions.
- `GITHUB_TOKEN_<OWNER>`: optional token for another owner, e.g.
  `GITHUB_TOKEN_SIDEQUEST_LABS`. Owner names are uppercased, with punctuation
  replaced by underscores. The current installation uses the verified repository
  token for personal and organization access.
- `GITHUB_WEBHOOK_SECRET`: random signing secret matching every installed webhook.
- `GITHUB_REPOSITORIES`: comma-separated exact `owner/repo` or `owner/*` entries.
  The deployed configuration covers `aranlucas/*` and `sidequest-labs/*`.
- `BASE_BRANCH`: allowed merge target. `default` uses each repository's default
  branch; an explicit name such as `main` restricts all repositories to that branch.
- `REQUIRED_CHECKS`: `*` (default) accepts each repository's own check names while
  requiring at least one check and success for every observed check. A comma-separated
  list additionally requires successful checks with those exact names.
- `MIN_APPROVALS`: current-head human collaborator approvals; minimum/default `1`.
  The author and bot accounts do not count. Active change requests block merging.
- `MERGE_METHOD`: `squash` (default), `merge`, or `rebase`; enable it in each repository.
- `DRY_RUN`: `true` by default; `false` enables actual merging after review.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`: Redis credentials.
  The Vercel integration instead injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`,
  which the SDK also accepts. Use separate databases for separate environments.

Protect merge targets in GitHub with required CI, current reviews, resolved
conversations, and up-to-date branches. GitHub enforces its own repository rules;
the bot should not be exempt from them.

## Webhooks and review behavior

Configure `https://YOUR-DEPLOYMENT/webhooks/github` with `application/json`, the
matching signing secret, and **Pull requests**, **Pull request reviews**,
**Check runs**, **Check suites**, and **Statuses** events.

Every inspectable open PR is reviewed automatically; **no label is required**.
Draft PRs and PRs waiting on CI or approval still get a model review, while the
merge gates hold them. Closed PRs, incomplete or binary diffs, empty diffs, over
100 changed files, and patches exceeding 120,000 characters are held without an
incomplete model review. A changed code-review input triggers a new review;
repeated CI/review events reuse a cached decision for the same input.

The channel verifies HMAC over raw bytes, limits payload size, validates the
repository, and waits for durable Eve acceptance before returning `202`.
A `202` means accepted, not reviewed or merged. Events queue per PR.

`review-pull-request` takes no model-supplied target. It uses the verified webhook
principal, acquires a per-PR Redis lock, and fetches current GitHub state. The
review model has no tools. The outer Eve agent has only this guarded tool;
shell, filesystem, browsing, and delegation tools are disabled.

A merge additionally requires an open non-draft PR, allowed base branch, clean
GitHub merge state, current approvals, no change requests, successful CI, and a
model decision with no reported risks. The tool refetches and compares state,
verifies lock ownership, and merges with the exact reviewed head SHA. Provider
errors, malformed decisions, stale state, or Redis failure prevent merging.
Model judgment can be wrong; it does not replace GitHub policy or human approvals.

The tool writes structured `pr-review` logs and retains delivery results and
review decisions in Redis for seven days. It does not post PR comments. Errors
appear in Eve runs and server logs. Correct the issue and redeliver the webhook;
GitHub does not see failures that occur after Eve's `202` receipt.

The production installation uses the free Upstash resource `pr-bot-redis`.
Webhooks cover the active personal and `sidequest-labs` repositories configured
at installation time. The owner wildcard permits new repositories, but a newly
created repository still needs its webhook installed. Archived repositories are
excluded. A crash after merging cannot merge that same PR twice: a retry sees it
is already merged.

## Deployment

```sh
pnpm exec eve link --project pr-bot --non-interactive
# Set the environment variables in Vercel.
pnpm exec eve deploy
```

Vercel uses the pinned pnpm version and lockfile. Use `pnpm build` as the build
command and Node.js 24. The standalone agent needs no frontend or service graph.
If Deployment Protection applies, configure GitHub webhook access while retaining
HMAC verification.

Verify a signed GitHub ping and a draft PR review before enabling actual merges.
GitHub-hosted CI also requires an account with working Actions billing/capacity;
account billing failures are independent of local test results.

## Current rollout status

The pnpm/Oxforge and free-only release is pushed to `main`. Local lint, format,
type checks, 49 tests, and the Eve build pass. Live API checks verified private
check-run access on personal and `sidequest-labs` repositories, plus free-model
structured output and tool calling.

Vercel rejected the release because the account reached its daily free deployment
limit. The 65 installed bot webhooks are paused while the previous version is
still deployed. Actual merging remains disabled (`DRY_RUN=true`).

After deployment capacity is restored, deploy this checkout and then resume delivery:

```sh
pnpm exec eve deploy
pnpm webhooks:resume
```

The webhook command uses GitHub CLI authentication and the local installation
inventory at `.vercel/repository-webhooks.json`. It verifies each webhook's URL
before changing it. `pnpm webhooks:pause` pauses the same installation.
Run a draft PR through the deployed service before setting `DRY_RUN=false`.
