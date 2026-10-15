import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { Octokit } from "@octokit/rest";
import { z } from "zod";

const run = promisify(execFile);

const mode = z.enum(["resume", "pause"]).parse(process.argv[2]);

const expectedUrl = "https://pr-bot-kohl.vercel.app/webhooks/github";

const records = z
  .array(
    z.object({
      repository: z.string().min(1),
      hookId: z.number().int().positive(),
    }),
  )
  .parse(JSON.parse(await readFile(".vercel/repository-webhooks.json", "utf8")));

const { stdout } = await run("gh", ["auth", "token"], { encoding: "utf8" });

const api = new Octokit({ auth: stdout.trim(), request: { timeout: 20_000 } });

const queue = [...records];

async function worker(): Promise<void> {
  const record = queue.shift();

  if (!record) {
    return;
  }

  const [owner, repo] = record.repository.split("/");
  const args = { owner, repo, hook_id: record.hookId };
  const { data: hook } = await api.repos.getWebhook(args);

  if (hook.config.url !== expectedUrl) {
    throw new Error(`Refusing to change an unrelated webhook in ${record.repository}`);
  }

  await api.repos.updateWebhook({ ...args, active: mode === "resume" });
  process.stdout.write(`${mode}: ${record.repository}\n`);
  await worker();
}

await Promise.all(Array.from({ length: 4 }, worker));

process.stdout.write(`Updated ${records.length} bot webhooks.\n`);
