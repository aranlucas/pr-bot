import { Octokit } from "@octokit/rest";
import { githubToken } from "@/config";

export interface Target {
  readonly repository: string;
  readonly number: number;
  readonly delivery: string;
}

export interface Check {
  readonly name: string;
  readonly success: boolean;
}

export interface ChangedFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: string;
  readonly patch?: string;
}

export interface MergeResult {
  readonly merged: boolean;
  readonly sha?: string;
  readonly message: string;
}

export interface GitHubOptions {
  readonly fetch?: typeof fetch;
  readonly token?: string;
  readonly repository?: string;
}

export interface Snapshot {
  readonly head: string;
  readonly base: string;
  readonly baseBranch: string;
  readonly defaultBranch: string;
  readonly state: string;
  readonly draft: boolean;
  readonly merged: boolean;
  readonly mergeable: boolean | null;
  readonly mergeableState: string;
  readonly labels: readonly string[];
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly checks: readonly Check[];
  readonly approvals: readonly string[];
  readonly changesRequested: boolean;
  readonly completeDiff: boolean;
  readonly files: readonly ChangedFile[];
}

export interface GitHub {
  snapshot(target: Target): Promise<Snapshot>;
  prsForCommit(repository: string, sha: string): Promise<number[]>;
  merge(target: Target, sha: string, method: "merge" | "squash" | "rebase"): Promise<MergeResult>;
}

function repoArgs(repository: string) {
  const [owner, repo] = repository.split("/");

  return { owner, repo };
}

export function createGitHub(options?: GitHubOptions): GitHub {
  const api = new Octokit({
    auth: options?.token ?? githubToken(options?.repository ?? ""),
    request: { timeout: 20_000, fetch: options?.fetch },
  });

  return {
    async prsForCommit(repository, sha) {
      const prs = await api.paginate(api.repos.listPullRequestsAssociatedWithCommit, {
        ...repoArgs(repository),
        commit_sha: sha,
        per_page: 100,
      });

      return prs.flatMap((pr) =>
        pr.state === "open" && pr.base.repo.full_name.toLowerCase() === repository
          ? [pr.number]
          : [],
      );
    },
    async snapshot(target) {
      const args = { ...repoArgs(target.repository), pull_number: target.number };
      const { data: pr } = await api.pulls.get(args);
      const ref = { ...repoArgs(target.repository), ref: pr.head.sha, per_page: 100 };

      const [files, checks, statuses, reviews] = await Promise.all([
        api.pulls.listFiles({ ...args, per_page: 100 }).then((response) => response.data),
        api.paginate(api.checks.listForRef, { ...ref, filter: "latest" }),
        api.paginate(api.repos.listCommitStatusesForRef, ref),
        api.paginate(api.pulls.listReviews, { ...args, per_page: 100 }),
      ]);

      const latestReviews = new Map<string, (typeof reviews)[number]>();

      for (const review of reviews.toSorted((a, b) => a.id - b.id)) {
        if (review.user && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) {
          latestReviews.set(review.user.login, review);
        }
      }

      const approvals = (
        await Promise.all(
          [...latestReviews].map(async ([login, review]) => {
            if (
              review.state !== "APPROVED" ||
              review.commit_id !== pr.head.sha ||
              login === pr.user.login ||
              review.user?.type !== "User"
            ) {
              return null;
            }

            const { data } = await api.repos.getCollaboratorPermissionLevel({
              ...repoArgs(target.repository),
              username: login,
            });

            return ["admin", "maintain", "write"].includes(data.permission) ? login : null;
          }),
        )
      ).filter((login) => login !== null);

      const latestStatuses = new Map<string, (typeof statuses)[number]>();

      for (const status of statuses.toSorted((a, b) => b.id - a.id)) {
        if (!latestStatuses.has(status.context)) {
          latestStatuses.set(status.context, status);
        }
      }

      return {
        head: pr.head.sha,
        base: pr.base.sha,
        baseBranch: pr.base.ref,
        defaultBranch: pr.base.repo.default_branch ?? "main",
        state: pr.state,
        draft: pr.draft ?? false,
        merged: pr.merged,
        mergeable: pr.mergeable,
        mergeableState: pr.mergeable_state,
        labels: pr.labels.map((label) => label.name).toSorted(),
        title: pr.title,
        body: pr.body ?? "",
        author: pr.user.login,
        checks: [
          ...checks.map((check) => ({
            name: check.name,
            success: check.status === "completed" && check.conclusion === "success",
          })),
          ...[...latestStatuses.values()].map((status) => ({
            name: status.context,
            success: status.state === "success",
          })),
        ].toSorted((a, b) => a.name.localeCompare(b.name)),
        approvals: approvals.toSorted(),
        changesRequested: [...latestReviews.values()].some(
          (review) => review.state === "CHANGES_REQUESTED",
        ),
        completeDiff:
          files.length === pr.changed_files &&
          files.every(
            (file) =>
              file.patch !== undefined &&
              file.patch.split("\n").filter((line) => line.startsWith("+")).length ===
                file.additions &&
              file.patch.split("\n").filter((line) => line.startsWith("-")).length ===
                file.deletions,
          ) &&
          files.reduce((total, file) => total + (file.patch?.length ?? 0), 0) <= 120_000,
        files: files.map((file) => ({
          path: file.filename,
          previousPath: file.previous_filename,
          status: file.status,
          patch: file.patch,
        })),
      };
    },
    async merge(target, sha, merge_method) {
      return (
        await api.pulls.merge({
          ...repoArgs(target.repository),
          pull_number: target.number,
          sha,
          merge_method,
        })
      ).data;
    },
  };
}
