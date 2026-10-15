import { createAppAuth } from "@octokit/auth-app";
import { defineState } from "eve/context";

// The GitHub channel restores the installation identity for each webhook turn.
export const githubInstallation = defineState<number | null>(
  "pr-bot.github-installation",
  () => null,
);

export async function githubToken(): Promise<string> {
  const installationId = githubInstallation.get();

  if (!installationId) {
    throw new Error("A GitHub App installation is required");
  }

  const auth = createAppAuth({
    appId: required("GITHUB_APP_ID"),
    privateKey: required("GITHUB_APP_PRIVATE_KEY").replaceAll(String.raw`\n`, "\n"),
    installationId,
  });

  return (await auth({ type: "installation" })).token;
}

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}
