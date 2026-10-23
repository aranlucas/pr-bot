import { createAppAuth } from "@octokit/auth-app";
import { createOctokit, type GithubTokenCall } from "@github-tools/sdk";
import { z } from "zod";
import { env } from "@/env";

const auth = createAppAuth({
  appId: env.GITHUB_APP_ID,
  privateKey: env.GITHUB_APP_PRIVATE_KEY,
});

const installationResponse = z.object({ id: z.number() });

const installations = new Map<string, number>();

const appIdentity = z.object({ slug: z.string().regex(/^[a-z0-9-]+$/iu) });

let botLogin: string | undefined;

// SDK 1.18's extension has no authenticated-App metadata tool. Use its public
// Octokit client with App auth, independently of the channel's mention alias.
export async function githubBotLogin(): Promise<string> {
  if (botLogin !== undefined) {
    return botLogin;
  }

  const { token } = await auth({ type: "app" });
  const { data } = await createOctokit(token).rest.apps.getAuthenticated();
  const { slug } = appIdentity.parse(data);
  // Cache only success so a later event can retry a failed identity lookup.
  botLogin = `${slug.toLowerCase()}[bot]`;

  return botLogin;
}

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
