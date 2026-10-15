import { z } from 'zod';

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export function config() {
  const list = (value: string) => value.split(',').map(s => s.trim()).filter(Boolean);
  return {
    repositories: new Set(list(required('GITHUB_REPOSITORIES')).map(s => s.toLowerCase())),
    baseBranch: process.env.BASE_BRANCH || 'main',
    label: process.env.MERGE_LABEL || 'agent:merge',
    requiredChecks: z.array(z.string().min(1)).min(1).parse(list(required('REQUIRED_CHECKS'))),
    minApprovals: z.coerce.number().int().min(1).parse(process.env.MIN_APPROVALS || '1'),
    mergeMethod: z.enum(['squash', 'merge', 'rebase']).parse(process.env.MERGE_METHOD || 'squash'),
    dryRun: z.enum(['true', 'false']).parse(process.env.DRY_RUN || 'true') === 'true',
  };
}
export type Config = ReturnType<typeof config>;
