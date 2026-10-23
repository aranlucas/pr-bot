import { createHash } from "node:crypto";
import {
  NodeClient,
  Scope,
  defaultStackParser,
  makeNodeTransport,
  type ErrorEvent,
} from "@sentry/node";
import type { ProviderSetupContext } from "eve/instrumentation";
import { z } from "zod";
import { env } from "@/env";

const failure = z.object({
  source: z.literal("pr-bot.runtime"),
  event: z.string().min(1),
  operationId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().optional(),
  terminal: z.boolean().optional(),
  stepIndex: z.number().optional(),
  attemptIndex: z.number().optional(),
  durationMs: z.number().optional(),
  tool: z.string().optional(),
  callId: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  channel: z.string().optional(),
  deliveryId: z.string().optional(),
  requestId: z.string().optional(),
  errorCode: z.string().optional(),
  outcome: z.string().optional(),
  finishReason: z.string().optional(),
  resultType: z.string().optional(),
  responseModelId: z.string().optional(),
  responseId: z.string().optional(),
});

type Failure = z.infer<typeof failure>;

// Callers pass the JSON-safe metadata they already emit to runtime logs. The
// schema above parses it and enforces the runtime source marker.
export type FailureMetadata = Omit<z.input<typeof failure>, "source"> & { source: string };

const errorEvents = new Set(["session.failed", "turn.failed"]);

let client: NodeClient | undefined;

function ignored(record: Failure): boolean {
  return (
    record.outcome === "cancelled" ||
    record.outcome === "abandoned" ||
    failureKind(record) === "policy_denial"
  );
}

function failureKind(record: Failure) {
  if (record.event === "tool.call.failed" && record.errorCode === "TOOL_EXECUTION_DENIED") {
    return "policy_denial";
  }

  if (errorEvents.has(record.event)) {
    return "terminal_failure";
  }

  if (record.event.startsWith("model.") || record.event.startsWith("step.attempt.")) {
    return "attempt_failure";
  }

  return "operation_failure";
}

function levelOf(record: Failure): "error" | "warning" | "info" {
  if (ignored(record)) {
    return "info";
  }

  return errorEvents.has(record.event) ? "error" : "warning";
}

// Only the fields below are sent. Runtime metadata may include inputs, outputs,
// or error objects, and Sentry would also merge the ambient scope; neither may
// reach Sentry.
function describe(record: Failure) {
  return {
    message: `PR Bot ${record.event}`,
    fingerprint: ["pr-bot", record.event, record.tool ?? "none", record.errorCode ?? "unknown"],
    tags: {
      lifecycle: record.event,
      failureKind: failureKind(record),
      ...(record.errorCode && { errorCode: record.errorCode }),
      ...(record.model && { model: record.model }),
      ...(record.provider && { provider: record.provider }),
    },
    contexts: { runtime: record },
  };
}

export function buildFailureEvent(value: FailureMetadata): ErrorEvent | undefined {
  const parsed = failure.safeParse(value);

  if (!parsed.success) {
    return undefined;
  }

  const record = parsed.data;

  if (ignored(record)) {
    return undefined;
  }

  return {
    type: undefined,
    event_id: createHash("sha256")
      .update(`${record.operationId}:${record.event}`)
      .digest("hex")
      .slice(0, 32),
    level: levelOf(record),
    ...describe(record),
  };
}

// Rebuild the event from validated metadata only, so data merged from global
// scopes cannot reach Sentry.
function metadataOnly(event: ErrorEvent): ErrorEvent | null {
  const parsed = failure.safeParse(event.contexts?.runtime);

  if (!parsed.success || ignored(parsed.data)) {
    return null;
  }

  const record = parsed.data;

  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: "node",
    environment: event.environment,
    release: event.release,
    level: event.level,
    ...describe(record),
  };
}

export function setupSentry({ environment }: Pick<ProviderSetupContext, "environment">): void {
  if (!env.SENTRY_DSN) {
    return;
  }

  client = new NodeClient({
    dsn: env.SENTRY_DSN,
    environment,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    integrations: [],
    enableOpenTelemetrySetup: false,
    enableRuntimeChannelInjection: false,
    sendClientReports: false,
    includeServerName: false,
    transport: makeNodeTransport,
    stackParser: defaultStackParser,
    beforeSend: metadataOnly,
  });
  client.init();
}

export function captureRuntimeFailure(value: FailureMetadata): void {
  if (!client) {
    return;
  }

  const event = buildFailureEvent(value);

  if (!event) {
    return;
  }

  const scope = new Scope();
  scope.setClient(client);
  scope.captureEvent(event);
}

export function reportRuntimeFailure(value: FailureMetadata): void {
  const parsed = failure.safeParse(value);

  if (!parsed.success) {
    return;
  }

  const record = parsed.data;
  const level = levelOf(record);
  const line = JSON.stringify({ ...record, level, failureKind: failureKind(record) });

  if (level === "info") {
    process.stdout.write(`${line}\n`);
  } else {
    process.stderr.write(`${line}\n`);
  }

  captureRuntimeFailure(record);
}

export async function flushSentry(): Promise<void> {
  await client?.flush(2_000);
}

export async function closeSentry(): Promise<void> {
  await client?.close(2_000);
  client = undefined;
}
