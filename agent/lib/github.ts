import { createAppAuth } from "@octokit/auth-app";
import type { GithubTokenCall } from "@github-tools/sdk";
import { z } from "zod";
import { env } from "@/env";

const auth = createAppAuth({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_APP_PRIVATE_KEY,
});

const installationResponse = z.object({ id: z.number() });

const installations = new Map<string, number>();

interface RepositoryCall extends Pick<GithubTokenCall, "owner" | "repo"> {
  toolName: string;
}

// The repository's installation, not the webhook's, so a call to any repo the
// App is installed on gets a token for that repo.
async function installationFor(owner: string, repo: string): Promise<number> {
  const key = `${owner}/${repo}`.toLowerCase();
  const cached = installations.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const { token } = await auth({ type: "app" });

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/installation`, {
    headers: { accept: "application/vnd.github+json", authorization: `bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`The GitHub App is not installed on ${owner}/${repo} (${response.status})`);
  }

  const { id } = installationResponse.parse(await response.json());
  installations.set(key, id);

  return id;
}

export async function githubToken(call?: RepositoryCall): Promise<string> {
  if (!call?.owner || !call.repo) {
    throw new Error(
      `${call?.toolName ?? "This call"} needs an owner and repo to pick an installation`,
    );
  }

  const installationId = await installationFor(call.owner, call.repo);

  return (await auth({ type: "installation", installationId })).token;
}
