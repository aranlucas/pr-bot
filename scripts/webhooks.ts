import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);

const mode = z.enum(["resume", "pause"]).parse(process.argv[2]);

const expectedUrl = "https://pr-bot-kohl.vercel.app/webhooks/github";

const records = z
  .array(
    z.object({
      repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      hookId: z.number().int().positive(),
    }),
  )
  .parse(JSON.parse(await readFile(".vercel/repository-webhooks.json", "utf8")));

const queue = [...records];

async function worker(): Promise<void> {
  const record = queue.shift();

  if (!record) {
    return;
  }

  const path = `repos/${record.repository}/hooks/${record.hookId}`;
  const existing = await run("gh", ["api", path], { encoding: "utf8" });

  const hook = z
    .object({ config: z.object({ url: z.string() }) })
    .parse(JSON.parse(existing.stdout));

  if (hook.config.url !== expectedUrl) {
    throw new Error(`Refusing to change an unrelated webhook in ${record.repository}`);
  }

  await run("gh", ["api", path, "--method", "PATCH", "-F", `active=${String(mode === "resume")}`]);
  process.stdout.write(`${mode}: ${record.repository}\n`);
  await worker();
}

await Promise.all(Array.from({ length: 4 }, worker));

process.stdout.write(`Updated ${records.length} bot webhooks.\n`);
