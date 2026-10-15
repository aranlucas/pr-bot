import { Octokit } from '@octokit/rest';
import { required } from './config.js';

export interface Target { repository: string; number: number; delivery: string }
export interface Snapshot {
  head: string;
  base: string;
  baseBranch: string;
  state: string;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  labels: string[];
  title: string;
  body: string;
  author: string;
  checks: { name: string; success: boolean }[];
  approvals: string[];
  changesRequested: boolean;
  completeDiff: boolean;
  files: { path: string; previousPath?: string; status: string; patch?: string }[];
}
export interface GitHub {
  snapshot(target: Target): Promise<Snapshot>;
  prsForCommit(repository: string, sha: string): Promise<number[]>;
  merge(target: Target, sha: string, method: 'merge' | 'squash' | 'rebase'): Promise<{ merged: boolean; sha?: string; message: string }>;
}
export function createGitHub(api = new Octokit({ auth: required('GITHUB_TOKEN'), request: { timeout: 20_000 } })): GitHub {
  const repoArgs = (repository: string) => {
    const [owner, repo] = repository.split('/');
    return { owner, repo };
  };
  return {
    async prsForCommit(repository, sha) {
      const prs = await api.paginate(api.repos.listPullRequestsAssociatedWithCommit, { ...repoArgs(repository), commit_sha: sha, per_page: 100 });
      return prs.filter(pr => pr.state === 'open' && pr.base.repo.full_name.toLowerCase() === repository).map(pr => pr.number);
    },
    async snapshot(target) {
      const args = { ...repoArgs(target.repository), pull_number: target.number };
      const { data: pr } = await api.pulls.get(args);
      const ref = { ...repoArgs(target.repository), ref: pr.head.sha, per_page: 100 };
      const [files, checks, statuses, reviews] = await Promise.all([
        // Oversized PRs are blocked; never send a silently truncated diff to the model.
        api.pulls.listFiles({ ...args, per_page: 100 }).then(r => r.data),
        api.paginate(api.checks.listForRef, { ...ref, filter: 'latest' }).then(r => r),
        api.paginate(api.repos.listCommitStatusesForRef, ref),
        api.paginate(api.pulls.listReviews, { ...args, per_page: 100 }),
      ]);
      const latestReviews = new Map<string, typeof reviews[number]>();
      for (const review of reviews.sort((a, b) => a.id - b.id)) {
        if (review.user && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latestReviews.set(review.user.login, review);
      }
      const approvals: string[] = [];
      for (const [login, review] of latestReviews) {
        if (review.state !== 'APPROVED' || review.commit_id !== pr.head.sha || login === pr.user.login || review.user?.type !== 'User') continue;
        const { data } = await api.repos.getCollaboratorPermissionLevel({ ...repoArgs(target.repository), username: login });
        if (['admin', 'maintain', 'write'].includes(data.permission)) approvals.push(login);
      }
      const latestStatuses = new Map<string, typeof statuses[number]>();
      for (const status of statuses.sort((a, b) => b.id - a.id)) if (!latestStatuses.has(status.context)) latestStatuses.set(status.context, status);
      return {
        head: pr.head.sha, base: pr.base.sha, baseBranch: pr.base.ref,
        state: pr.state, draft: pr.draft ?? false, merged: pr.merged,
        mergeable: pr.mergeable, mergeableState: pr.mergeable_state,
        labels: pr.labels.map(l => l.name).sort(), title: pr.title, body: pr.body || '', author: pr.user.login,
        checks: [
          ...checks.map(c => ({ name: c.name, success: c.status === 'completed' && c.conclusion === 'success' })),
          ...[...latestStatuses.values()].map(s => ({ name: s.context, success: s.state === 'success' })),
        ].sort((a, b) => a.name.localeCompare(b.name)),
        approvals: approvals.sort(),
        changesRequested: [...latestReviews.values()].some(r => r.state === 'CHANGES_REQUESTED'),
        completeDiff: files.length === pr.changed_files && files.every(f => typeof f.patch === 'string' && f.patch.split('\n').filter(line => line.startsWith('+')).length === f.additions && f.patch.split('\n').filter(line => line.startsWith('-')).length === f.deletions) && files.reduce((n, f) => n + (f.patch?.length || 0), 0) <= 120_000,
        files: files.map(f => ({ path: f.filename, previousPath: f.previous_filename, status: f.status, patch: f.patch })),
      };
    },
    async merge(target, sha, merge_method) {
      return (await api.pulls.merge({ ...repoArgs(target.repository), pull_number: target.number, sha, merge_method })).data;
    },
  };
}
