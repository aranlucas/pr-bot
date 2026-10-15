import { z } from "zod";

export interface Config {
  readonly repositories: ReadonlySet<string>;
  readonly baseBranch: string;
  readonly requiredChecks: readonly string[];
  readonly minApprovals: number;
  readonly mergeMethod: "squash" | "merge" | "rebase";
  readonly dryRun: boolean;
}

export function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing ${name}`);
  }

  return value;
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function config(): Config {
  return {
    repositories: new Set(list(required("GITHUB_REPOSITORIES")).map((item) => item.toLowerCase())),
    baseBranch: process.env.BASE_BRANCH ?? "default",
    requiredChecks:
      process.env.REQUIRED_CHECKS === "*" || !process.env.REQUIRED_CHECKS
        ? []
        : z
            .array(z.string().min(1))
            .min(1)
            .parse(list(required("REQUIRED_CHECKS"))),
    minApprovals: z.coerce
      .number()
      .int()
      .min(0)
      .parse(process.env.MIN_APPROVALS ?? "0"),
    mergeMethod: z.enum(["squash", "merge", "rebase"]).parse(process.env.MERGE_METHOD ?? "squash"),
    dryRun: z.enum(["true", "false"]).parse(process.env.DRY_RUN ?? "true") === "true",
  };
}

export function repositoryAllowed(repository: string, policy: Config): boolean {
  const owner = repository.split("/")[0];

  return policy.repositories.has(repository) || policy.repositories.has(`${owner}/*`);
}
