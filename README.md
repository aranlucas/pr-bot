<img src="assets/icon.svg" width="64" height="64" alt="">

# PR Bot

A [Vercel Eve](https://eve.dev/docs) agent that receives GitHub webhooks, reviews
pull request changes through [OpenRouter](https://openrouter.ai/docs/quickstart),
and automatically merges eligible PRs. It starts in **dry-run mode**.

Production endpoint: [pr-bot-kohl.vercel.app](https://pr-bot-kohl.vercel.app/eve/v1/health).
The connected repository is [aranlucas/pr-bot](https://github.com/aranlucas/pr-bot).

## Run locally

Requires Node.js 24+, npm, and Docker for Eve's default local sandbox template.

```sh
npm ci
cp .env.example .env.local
# Fill in .env.local, including the exact repository and CI check names.
npm run dev
```

Eve loads `.env.local` for development. Point a public HTTPS tunnel at the local
Eve server (port 2000 by default), then configure the GitHub webhook below.
Interactive Eve sessions are disabled: webhook service principals are the only
callers allowed to run the review tool.

## Configuration

Set these in `.env.local` locally and in your Vercel project's environment when
hosting:

- `OPENROUTER_API_KEY`: OpenRouter API key. PR titles, descriptions and diffs are
  sent to OpenRouter and the selected model provider.
- `OPENROUTER_MODEL`: model ID supporting tool calling and structured JSON
  output. Defaults to `anthropic/claude-sonnet-4.5`.
- `GITHUB_TOKEN`: fine-grained token limited to the selected repositories, with
  Contents and Pull requests **read/write**, Checks and Commit statuses **read**,
  and Metadata **read**. Use an account with no branch-protection bypass rights.
- `GITHUB_WEBHOOK_SECRET`: a long random secret, also configured on the webhook.
- `GITHUB_REPOSITORIES`: comma-separated exact `owner/repo` allowlist.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`: a Redis database for
  locks and completed delivery results. Use separate databases for separate
  environments. The Vercel Upstash integration can supply `KV_REST_API_URL` and
  `KV_REST_API_TOKEN` instead; the Redis SDK supports those names automatically.
  Redis failure prevents merging.
- `REQUIRED_CHECKS`: mandatory comma-separated check-run names or status contexts
  that must pass, e.g. `test,typecheck`. Names must match GitHub exactly.
- `BASE_BRANCH`: allowed target branch; defaults to `main`.
- `MERGE_LABEL`: opt-in label; defaults to `agent:merge`.
- `MIN_APPROVALS`: current-head approvals from collaborators with write access;
  minimum and default is `1`. The PR author and bot accounts do not count.
- `MERGE_METHOD`: `squash` (default), `merge`, or `rebase`. Enable that method in
  the repository settings.
- `DRY_RUN`: defaults to `true`. Set exactly `false` to enable actual merging.

Protect the target branch in GitHub: require CI and reviews, dismiss stale
approvals, require conversation resolution, and require the branch to be up to
date. GitHub remains the final authority for those rules, including code owners
and check provenance. The bot must not have an exemption from them.

## GitHub webhook

In each allowed repository, open **Settings → Webhooks → Add webhook**:

1. Payload URL: `https://YOUR-DEPLOYMENT/webhooks/github`.
2. Content type: `application/json`.
3. Secret: the same value as `GITHUB_WEBHOOK_SECRET`.
4. Select **Pull requests**, **Pull request reviews**, **Check runs**,
   **Check suites**, and **Statuses**.

Create the `agent:merge` label and apply it to a PR when you want the agent to
consider merging it. Relevant PR changes, review changes and completed CI events
trigger reevaluation. Events about commits are resolved back to their associated
open PRs, including when check webhooks omit PR associations.

## Merge behavior

The webhook validates the HMAC signature over the raw bytes, bounds payload size,
validates the target, and waits for Eve to durably accept the message before
returning `202`. A `202` means accepted, not merged. Messages are queued per PR.

The agent calls `review_pull_request`. Its trusted PR identity comes from the
verified webhook principal, never from model arguments. The tool:

1. Deduplicates completed deliveries and acquires a 10-minute Redis lock per PR.
2. Fetches current PR details, files, check runs, commit statuses, and reviews.
3. Holds drafts, closed PRs, wrong branches, unlabeled PRs, unknown or non-clean
   merge states, missing approvals, change requests, missing required CI, and
   any pending or unsuccessful observed checks. Skipped and neutral checks are
   held too.
4. Holds PRs with over 100 files, missing or truncated patches, binary changes,
   or over 120,000 characters of patches. They need manual review.
5. Uses OpenRouter structured output to independently review the diff. `hold`,
   reported risks, malformed output, and provider errors cannot authorize a merge.
6. Refetches GitHub state and compares it with the reviewed snapshot. A changed
   head, base, description, label, approval, check result, or diff prevents merging.
7. In live mode, verifies lock ownership and calls GitHub's merge API with the
   exact reviewed head SHA. A new push cannot be merged with an old decision.

The review model has no tools. The outer Eve agent has only the guarded review
tool; shell access, file access, browsing, and delegation are disabled. PR text
and patches are treated as untrusted data. Model judgment remains fallible;
branch protection, collaborator approval and required CI are enforced separately.

Review outcomes (`held`, `dry-run`, `merged`) are written as structured
`pr-review` logs and retained in Redis for seven days, keyed by delivery and PR.
The bot does not post comments on PRs. Review failures appear in Eve run traces
and server logs. Correct the issue and redeliver the webhook in GitHub; Eve's
`202` receipt does not tell GitHub about a later agent failure. Delivery retries
can start another Eve turn, but completed tool evaluations are deduplicated.
A crash after GitHub merges but before caching cannot merge the same PR twice:
a retry sees the merged PR and holds it.

## Deploy to Vercel

```sh
npx eve link --project pr-bot --non-interactive
# Add all environment variables in the Vercel project; keep DRY_RUN=true initially.
npx eve deploy
```

The standalone `eve build` generates the Vercel output when run on Vercel. Set
Node.js 24 and use `npm run build` as the build command. Use the standalone agent
layout in this repository; it does not need a Next.js app or a service graph.
If Vercel Deployment Protection is enabled, configure a bypass for the webhook
URL so GitHub can reach it; the webhook's own HMAC check remains required.

Verify a signed GitHub **ping**, apply the merge label to a test PR, and inspect
the dry-run outcome in logs / Eve Agent Runs. Then set `DRY_RUN=false`, redeploy,
and trigger a new event. A redelivery with an already completed delivery ID uses
its cached result, including a prior dry-run result.

Installing this repository alone does not create a webhook or deployment. The
current production installation has a GitHub webhook at
`https://pr-bot-kohl.vercel.app/webhooks/github` and a free Upstash Redis resource
named `pr-bot-redis`.

## Verify

```sh
npm test
npm run typecheck
npm run build
```

Tests use fake GitHub and Redis services and require no credentials. They cover
signature verification, event routing, hard merge gates, changed PR state,
model failures, SHA pinning, delivery deduplication and lock ownership. CI runs
`test` and `typecheck` as separate check jobs. A live OpenRouter review and merge
require configured credentials and a test repository.
