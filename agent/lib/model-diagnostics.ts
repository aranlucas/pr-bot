import { randomUUID } from "node:crypto";
import { type wrapLanguageModel, type LanguageModelMiddleware } from "ai";

type Model = ReturnType<typeof wrapLanguageModel>;

type ModelStream = Awaited<ReturnType<Model["doStream"]>>;

type StreamPart = ModelStream["stream"] extends ReadableStream<infer Part> ? Part : never;

type Outcome = "completed" | "truncated" | "interrupted" | "aborted" | "error";

// Eve's metadata-only lifecycle events omit partial output and stream timing.
// Observe the SDK's typed stream here without retaining any generated content.
export const modelDiagnostics: LanguageModelMiddleware = {
  async wrapStream({ doStream, model, params }) {
    const callId = randomUUID();
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    let reported = false;
    let providerReadyMs: number | undefined;
    let firstPartMs: number | undefined;
    let lastPartMs: number | undefined;
    let firstReasoningMs: number | undefined;
    let firstTextMs: number | undefined;
    let firstToolInputMs: number | undefined;
    let lastOutputMs: number | undefined;
    let reasoningCharacters = 0;
    let textCharacters = 0;
    let toolInputCharacters = 0;
    let responseModelId: string | undefined;
    let responseId: string | undefined;
    let sawFinish = false;

    const identity = {
      source: "pr-bot.model-stream",
      callId,
      model: model.modelId,
      provider: model.provider,
    };

    function report(outcome: Outcome) {
      if (reported) {
        return;
      }

      reported = true;
      params.abortSignal?.removeEventListener("abort", onAbort);
      const durationMs = elapsed();

      const timedOut =
        params.abortSignal?.reason instanceof Error &&
        params.abortSignal.reason.name === "TimeoutError";

      process.stdout.write(
        `${JSON.stringify({
          ...identity,
          event: "model.stream.settled",
          outcome,
          ...(outcome === "aborted" && { abortKind: timedOut ? "timeout" : "cancelled" }),
          durationMs,
          providerReadyMs,
          firstPartMs,
          firstReasoningMs,
          firstTextMs,
          firstToolInputMs,
          lastOutputMs,
          ...(lastPartMs !== undefined && { lastPartAgeMs: durationMs - lastPartMs }),
          ...(lastOutputMs !== undefined && { lastOutputAgeMs: durationMs - lastOutputMs }),
          reasoningCharacters,
          textCharacters,
          toolInputCharacters,
          responseModelId,
          responseId,
          sawFinish,
        })}\n`,
      );
    }

    function onAbort() {
      report("aborted");
    }

    process.stdout.write(`${JSON.stringify({ ...identity, event: "model.stream.started" })}\n`);
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });

    if (params.abortSignal?.aborted) {
      onAbort();
    }

    let result: ModelStream;

    try {
      result = await doStream();
      providerReadyMs = elapsed();
    } catch (error) {
      report(params.abortSignal?.aborted ? "aborted" : "error");
      throw error;
    }

    const observer = new TransformStream<StreamPart, StreamPart>({
      transform(part, controller) {
        const now = elapsed();
        firstPartMs ??= now;
        lastPartMs = now;

        switch (part.type) {
          case "response-metadata":
            responseModelId = part.modelId;
            responseId = part.id;
            break;
          case "reasoning-delta":
            if (part.delta.length > 0) {
              firstReasoningMs ??= now;
              lastOutputMs = now;
              reasoningCharacters += part.delta.length;
            }

            break;
          case "text-delta":
            if (part.delta.length > 0) {
              firstTextMs ??= now;
              lastOutputMs = now;
              textCharacters += part.delta.length;
            }

            break;
          case "tool-input-delta":
            if (part.delta.length > 0) {
              firstToolInputMs ??= now;
              lastOutputMs = now;
              toolInputCharacters += part.delta.length;
            }

            break;
          case "tool-call":
            firstToolInputMs ??= now;
            lastOutputMs = now;
            break;
          case "finish":
            sawFinish = true;
            break;
          case "error":
            report("error");
            break;
          case "custom":
          case "file":
          case "raw":
          case "reasoning-end":
          case "reasoning-file":
          case "reasoning-start":
          case "source":
          case "stream-start":
          case "text-end":
          case "text-start":
          case "tool-approval-request":
          case "tool-input-end":
          case "tool-input-start":
          case "tool-result":
            break;
        }

        controller.enqueue(part);
      },
      flush() {
        report(sawFinish ? "completed" : "truncated");
      },
    });

    // pipeTo forwards errors, cancellation, and backpressure to the original
    // stream. Its rejection also covers failures that never emit an error part.
    void result.stream.pipeTo(observer.writable).catch(() => {
      report(params.abortSignal?.aborted ? "aborted" : "interrupted");
    });

    return { ...result, stream: observer.readable };
  },
};
