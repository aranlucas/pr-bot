import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export function verifySignature(
  body: Readonly<Uint8Array>,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(body).digest();

  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

const prNumber = z.object({ number: z.number().int().positive() });

const schema = z.object({
  action: z.string().optional(),
  repository: z.object({ full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
  pull_request: prNumber.optional(),
  check_run: z.object({ head_sha: z.string(), pull_requests: z.array(prNumber) }).optional(),
  check_suite: z.object({ head_sha: z.string(), pull_requests: z.array(prNumber) }).optional(),
  sha: z.string().optional(),
});

export function parseEvent(event: string, body: string) {
  if (
    !["pull_request", "pull_request_review", "check_run", "check_suite", "status"].includes(event)
  ) {
    return null;
  }

  const value = schema.parse(JSON.parse(body));

  if (
    event === "pull_request" &&
    ![
      "opened",
      "reopened",
      "synchronize",
      "labeled",
      "unlabeled",
      "ready_for_review",
      "edited",
    ].includes(value.action ?? "")
  ) {
    return null;
  }

  if (
    event === "pull_request_review" &&
    !["submitted", "dismissed", "edited"].includes(value.action ?? "")
  ) {
    return null;
  }

  if (["check_run", "check_suite"].includes(event) && value.action !== "completed") {
    return null;
  }

  const check = event === "check_run" ? value.check_run : value.check_suite;

  if (["check_run", "check_suite"].includes(event) && !check) {
    throw new Error("Missing check payload");
  }

  if (["pull_request", "pull_request_review"].includes(event) && !value.pull_request) {
    throw new Error("Missing PR");
  }

  if (event === "status" && !value.sha) {
    throw new Error("Missing status SHA");
  }

  return {
    repository: value.repository.full_name.toLowerCase(),
    numbers: value.pull_request
      ? [value.pull_request.number]
      : (check?.pull_requests.map((pr) => pr.number) ?? []),
    sha: event === "status" ? value.sha : check?.head_sha,
  };
}
