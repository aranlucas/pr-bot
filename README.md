<img src="assets/icon.svg" width="64" height="64" alt="">

# PR Bot

A [Vercel Eve](https://eve.dev/docs) agent that reviews GitHub pull requests and
merges changes that pass both the review and deterministic GitHub checks.

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

Configure model access using the variables in `.env.example`. Store credentials as
Vercel Secrets. PR metadata and patches are sent to the configured review service.

- `GITHUB_APP_ID`: ID of the self-managed GitHub App (`5335315` for this installation).
- `GITHUB_APP_PRIVATE_KEY`: PEM private key, stored as a Vercel Secret. Eve and
  Octokit obtain short-lived installation tokens; personal access tokens are not used.
- `GITHUB_APP_SLUG`: `aranlucas-pr-bot`.
- `GITHUB_WEBHOOK_SECRET`: signing secret matching the App webhook.
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

Register a self-managed GitHub App with Contents and Pull requests read/write,
Checks and Commit statuses read, and the automatically included Metadata read.
Set its webhook to `https://YOUR-DEPLOYMENT/eve/v1/github` with the matching
signing secret. Subscribe to **Pull requests**, **Pull request reviews**,
**Check runs**, **Check suites**, and **Statuses**.

Install the App on each personal or organization account and select **All
repositories** to include current and future repositories. GitHub requires the App
to allow installation on other accounts for organization coverage. The server's
repository allowlist still limits which installations can start reviews. No
Vercel Connect connector, quota, or provider token exchange is involved.

Every inspectable open PR is reviewed automatically; **no label is required**.
Draft PRs and PRs waiting on CI or approval still get a model review, while the
merge gates hold them. Closed PRs, incomplete or binary diffs, empty diffs, over
100 changed files, and patches exceeding 120,000 characters are held without an
incomplete model review. A changed code-review input triggers a new review;
repeated CI/review events reuse a cached decision for the same input.

Eve's built-in GitHub channel verifies and dispatches PR events. A supplemental
adapter handles approval/status events, all check-associated PRs, and commit
lookup when GitHub omits those associations. It verifies signatures before
parsing and routes through the built-in channel's receive hook. Both paths bind
the verified installation and PR to a service principal; the tool cannot select
another target. Vercel enforces the request-body size limit. Events queue per PR.

Webhook acknowledgement means received or queued, not reviewed or merged. Eve's
native PR path acknowledges background dispatch with `200`; the supplemental
path waits for durable acceptance and returns `202`. Check Eve runs and server
logs for processing errors before redelivering an event.

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

Before an actual merge, the bot posts the reviewed commit, merge method, model
reason, and passed policy checks as a PR comment. Retries reuse the App's comment
for the same commit. If posting fails, the bot does not merge; if GitHub rejects
the merge, the comment is updated. Dry runs do not post merge announcements.

The tool writes structured `pr-review` logs and retains delivery results and
review decisions in Redis for seven days. Eve's built-in channel can post framework failure messages to PR threads. The
review tool's structured result remains in logs and Redis. Correct processing
errors and redeliver the webhook; failures after acknowledgement are not
reported through the original HTTP response.

The production installation uses the free Upstash resource `pr-bot-redis`.
The App is installed with **All repositories** on `aranlucas` and `sidequest-labs`.
Each review uses the installation ID from its authenticated event, so personal
and organization tokens are kept separate. A crash after merging cannot merge
that same PR twice: a retry sees it is already merged.

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

## Production verification

The self-managed App is installed on all 54 personal repositories and all 11
`sidequest-labs` repositories, including future repositories in both accounts.
The Production deployment uses `/eve/v1/github` directly; the unused Vercel
Connect connector was removed. The 65 legacy repository webhooks were deleted,
and the old bot PAT was revoked and removed from Vercel.

Production health and unsigned-request rejection passed. A temporary draft PR
verified actual GitHub delivery, Eve dispatch, installation authentication, and
a structured model review. The bot correctly held it for draft status,
missing approval, and unsuccessful checks. The test PR was closed and its branch
removed. Local checks include 60 tests and an Eve production build.

`DRY_RUN=false` is configured in Vercel Production. The activation deployment
was blocked by Vercel's daily deployment limit, so the last successful deployment
still runs in dry-run mode. Deploy this release to activate merging and its
explanation comments. Enable or pause App delivery through the GitHub App's
webhook settings.
