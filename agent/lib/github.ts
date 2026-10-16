import { createAppAuth } from "@octokit/auth-app";
import { env } from "@/env";

export async function githubToken(): Promise<string> {
  const auth = createAppAuth({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    installationId: env.GITHUB_APP_INSTALLATION_ID,
  });

  const appAuth = await auth({ type: "installation" });

  return appAuth.token;
}
