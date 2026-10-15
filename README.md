<img src="assets/icon.svg" width="64" height="64" alt="">

# PR Bot

A [Vercel Eve](https://eve.dev/docs) agent that reviews GitHub pull requests and
posts its findings before merging eligible changes. The main agent performs the
review directly; there is no nested model call.

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
- `MIN_APPROVALS`: required current-head human collaborator approvals; defaults
  to `0` (no bot-imposed human approval requirement). Set a positive count to
  require approvals. The author and bot accounts do not count. Active change
  requests and GitHub branch protection still apply.
- `MERGE_METHOD`: `squash` (default), `merge`, or `rebase`; enable it in each repository.
- `DRY_RUN`: `true` by default; `false` enables actual merging after review.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`: Redis credentials.
  The Vercel integration instead injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`,
  which the SDK also accepts. Use separate databases for separate environments.

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
Draft PRs and PRs waiting on CI or approval also receive a review. Closed PRs
receive no comment. Incomplete or binary diffs, empty diffs, over 100 changed
files, and patches exceeding 120,000 characters are identified as review
limitations; the agent does not claim a complete review of those changes.

Eve's built-in GitHub channel verifies and dispatches PR events. A supplemental
adapter handles approval/status events, all check-associated PRs, and commit
lookup when GitHub omits those associations. It verifies signatures before
parsing and routes through the built-in channel's receive hook. Both paths bind
the verified installation and PR to a service principal; the tool cannot select
another target. Vercel enforces the request-body size limit. Events queue per PR.

Webhook acknowledgement means received or queued, not reviewed or commented. Eve's
native PR path acknowledges background dispatch with `200`; the supplemental
path waits for durable acceptance and returns `202`. Check Eve runs and server
logs for processing errors before redelivering an event.

Before each turn, dynamic instructions fetch current PR metadata and patches
using the verified webhook principal and supply them to the main agent. The
agent reviews the changes itself and calls `post-comment` with the current
context's `reviewId` and its Markdown review. It can then call `merge` if the
review found no material unresolved defects or limitations. Shell, filesystem,
browsing, and delegation tools are disabled. Repository text is untrusted data.
The review focuses on concrete defects introduced by the change, with patch
evidence and consequences, rather than general objections to the stated goal.
Review depth is proportional to the change: low-risk documentation, typo, and
formatting edits can pass without runtime tests or inspection of unrelated files.
Style preferences, optional follow-up work, and speculative improvements do not
block merging; missing tests matter when a behavior change has a specific
untested failure case.

`post-comment` takes no model-supplied repository or PR number. It checks the
repository allowlist, acquires a per-PR Redis lock, validates the review ID
against the context stored for that delivery, and refetches the PR. Changed
review inputs reject the comment; a new webhook turn is needed for a fresh
review. A PR that closed during review is skipped. The final GitHub read and
comment write are separate requests, so the comment always names the reviewed
commit even if a push races the write.

Retries reuse only this App's review comment for the same commit. Existing
comments are updated only when their content changes. Repeated CI/review events
start a fresh main-agent review rather than reusing a separate model decision.
Comment failures remain retryable. Context fingerprints are retained in Redis
for seven days. Eve may also post framework failure messages to PR threads;
check Eve runs and server logs before redelivering failed events.

The `merge` tool requires a stored receipt from a successful `post-comment`
call for the same webhook delivery. A model assertion that it posted a comment
is insufficient. It refetches the PR and checks that the reviewed content is
unchanged, then enforces the existing branch, draft, CI, approval, change request,
and mergeability policy. Actual merges are pinned to the reviewed head SHA and
require a valid lock. `DRY_RUN=true` reports eligibility without merging. Before
an actual merge, the bot also posts an idempotent merge explanation; a failed
explanation prevents merging. GitHub branch protection still applies.

The main agent uses the configured FreeLLM API model. Metadata and patches are
sent to that provider as part of its normal turn. Model judgment can be wrong;
posting a comment proves that the review was published, not that it is correct.

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

Verify a signed GitHub ping and a draft PR review after deployment.
GitHub-hosted CI also requires an account with working Actions billing/capacity;
account billing failures are independent of local test results.

## Deployment verification

Local checks cover authenticated webhook dispatch, review context binding,
stale-review rejection, installation authentication, idempotent review
comments, and the post-before-merge guard. Run `pnpm check` and `pnpm build` before deployment. This change does
not update the live deployment or GitHub App permissions.
