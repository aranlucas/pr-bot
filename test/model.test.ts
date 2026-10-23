import { assert, afterEach, describe, test, vi } from "vitest";
import { generateText, isStepCount, streamText, tool, ToolLoopAgent } from "ai";
import { z } from "zod";

describe.each(["deadline", "caller cancellation"])("model %s", (stop) => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test.each(["headers", "body", "ongoing output", "reasoning"])(
    "aborts a slow provider before the function deadline (%s)",
    async (phase) => {
      vi.useFakeTimers();
      const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      // Native AbortSignal timers do not use Vitest's clock.
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("Model deadline", "TimeoutError")), ms);

        return controller.signal;
      });
      vi.resetModules();
      const { reviewModel } = await import("@/model");
      let providerAborted = false;
      vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
        const signal = init?.signal;
        assert.ok(signal);

        if (phase === "headers") {
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                providerAborted = true;
                reject(
                  signal.reason instanceof Error ? signal.reason : new Error("Provider aborted"),
                );
              },
              { once: true },
            );
          });
        }

        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const interval =
                  phase === "ongoing output" || phase === "reasoning"
                    ? setInterval(() => {
                        const chunk = {
                          id: "slow",
                          created: 1,
                          model: "auto",
                          choices: [
                            {
                              index: 0,
                              delta:
                                phase === "reasoning"
                                  ? { reasoning_content: "Private reasoning" }
                                  : { content: "Still working" },
                              finish_reason: null,
                            },
                          ],
                        };

                        controller.enqueue(
                          new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`),
                        );
                      }, 10_000)
                    : undefined;

                signal.addEventListener(
                  "abort",
                  () => {
                    providerAborted = true;
                    clearInterval(interval);
                    controller.error(signal.reason);
                  },
                  { once: true },
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        );
      });

      const errors: unknown[] = [];
      let settled = false;
      const caller = new AbortController();

      if (stop === "caller cancellation") {
        setTimeout(() => caller.abort(), 5_000);
      }

      const result = streamText({
        model: reviewModel,
        prompt: "Review this change",
        abortSignal: caller.signal,
      });

      const consumed = (async () => {
        try {
          for await (const part of result.fullStream) {
            if (part.type === "error") {
              errors.push(part.error);
            }
          }
        } catch (error) {
          errors.push(error);
        } finally {
          settled = true;
        }
      })();

      await vi.advanceTimersByTimeAsync(stop === "deadline" ? 89_999 : 4_999);
      assert.isFalse(providerAborted);
      await vi.advanceTimersByTimeAsync(1);
      assert.ok(providerAborted, "the provider must be aborted before Vercel kills the function");
      assert.ok(settled, "the model stream must settle so Eve can record the failure");
      await consumed;
      assert.strictEqual(vi.mocked(fetch).mock.calls.length, 1);

      const diagnostics = output.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes('"event":"model.stream.settled"'));

      assert.lengthOf(diagnostics, 1);

      const record = z
        .object({
          outcome: z.literal("aborted"),
          abortKind: z.enum(["timeout", "cancelled"]),
          reasoningCharacters: z.number(),
          textCharacters: z.number(),
          lastOutputAgeMs: z.number().optional(),
        })
        .parse(JSON.parse(diagnostics[0] ?? "null"));

      assert.strictEqual(record.abortKind, stop === "deadline" ? "timeout" : "cancelled");

      if (stop === "deadline" && phase === "reasoning") {
        assert.isAbove(record.reasoningCharacters, 0);
        assert.strictEqual(record.textCharacters, 0);
        assert.isAtMost(record.lastOutputAgeMs ?? Infinity, 10_000);
      }

      assert.notInclude(diagnostics.join(""), "Private reasoning");

      if (stop === "deadline") {
        assert.isNotEmpty(errors);
      }
    },
  );
});

describe.each([
  {
    provider: "FreeLLMAPI",
    baseURL: undefined,
    expectedURL: "https://freellmapi-production-1175.up.railway.app/v1/chat/completions",
  },
  {
    provider: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    expectedURL: "https://openrouter.ai/api/v1/chat/completions",
  },
])("$provider attribution", ({ baseURL, expectedURL }) => {
  test.each([
    { useToolLoop: false, streaming: false },
    { useToolLoop: true, streaming: false },
    { useToolLoop: false, streaming: true },
    { useToolLoop: true, streaming: true },
  ])(
    "identifies PR Bot on every step (tool loop: $useToolLoop, streaming: $streaming)",
    async ({ useToolLoop, streaming }) => {
      vi.stubEnv("FREELLM_API_BASE_URL", baseURL);
      vi.stubEnv("FREELLM_API_KEY", "test-model-key");
      vi.stubEnv("FREELLM_MODEL", "auto");
      vi.resetModules();
      const { reviewModel } = await import("@/model");

      const input = {
        owner: "acme",
        repo: "app",
        pullNumber: 42,
        body: "No concrete defects found.",
      };

      let requests = 0;

      vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
        assert.strictEqual(url, expectedURL);
        const headers = new Headers(init?.headers);
        const userAgent = z.string().parse(headers.get("user-agent"));
        assert.ok(!userAgent.includes("pr-bot"));
        assert.match(userAgent, /\bai-sdk-provider-utils\//);
        assert.ok(userAgent.includes("request-diagnostics/1.0"));
        assert.strictEqual(headers.get("http-referer"), "https://github.com/aranlucas/pr-bot");
        assert.strictEqual(headers.get("x-openrouter-title"), "PR Bot");
        assert.strictEqual(headers.get("x-title"), "PR Bot");
        assert.strictEqual(headers.get("authorization"), "Bearer test-model-key");
        assert.strictEqual(headers.get("x-request-id"), "review-test");

        if (useToolLoop) {
          assert.ok(userAgent.includes("ai-sdk-agent/tool-loop"));
        }

        assert.strictEqual(headers.get("content-type"), "application/json");
        requests++;
        const request = z.object({ body: z.string() }).parse(init);

        const body = z
          .object({
            model: z.string(),
            stream: z.boolean().optional(),
            stream_options: z.object({ include_usage: z.boolean() }).optional(),
            response_format: z.unknown().optional(),
            tools: z.array(
              z.object({ type: z.string(), function: z.object({ name: z.string() }) }),
            ),
          })
          .parse(JSON.parse(request.body));

        assert.strictEqual(body.model, "auto");
        assert.strictEqual(body.stream ?? false, streaming);
        assert.deepEqual(body.stream_options, streaming ? { include_usage: true } : undefined);
        assert.strictEqual(body.response_format, undefined);
        assert.strictEqual(body.tools[0].function.name, "github__addPullRequestComment");

        const message =
          requests === 1
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: "comment-call",
                    type: "function",
                    function: {
                      name: "github__addPullRequestComment",
                      arguments: JSON.stringify(input),
                    },
                  },
                ],
              }
            : { role: "assistant", content: "Review posted." };

        const finishReason = requests === 1 ? "tool_calls" : "stop";
        const metadata = { id: "review-test", created: 1, model: "auto" };
        const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

        if (streaming) {
          const chunks = [
            {
              ...metadata,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: message, finish_reason: null }],
            },
            {
              ...metadata,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            },
            {
              ...metadata,
              object: "chat.completion.chunk",
              choices: [],
              usage,
            },
          ];

          return Promise.resolve(
            new Response(
              chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
                "data: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } },
            ),
          );
        }

        return Promise.resolve(
          Response.json({
            ...metadata,
            object: "chat.completion",
            choices: [{ index: 0, message, finish_reason: finishReason }],
            usage,
          }),
        );
      });

      const settings = {
        model: reviewModel,
        tools: {
          github__addPullRequestComment: tool({
            description: "Post the review",
            inputSchema: z.object({
              owner: z.string(),
              repo: z.string(),
              pullNumber: z.number(),
              body: z.string(),
            }),
            execute: () => ({ posted: true }),
          }),
        },
        maxRetries: 0,
        stopWhen: isStepCount(2),
        headers: { "user-agent": "request-diagnostics/1.0", "x-request-id": "review-test" },
      };

      const prompt = "Review this test change and post your findings";

      const agent = new ToolLoopAgent(settings);

      const result = streaming
        ? useToolLoop
          ? await agent.stream({ prompt })
          : streamText({ ...settings, prompt })
        : useToolLoop
          ? await agent.generate({ prompt })
          : await generateText({ ...settings, prompt });

      const text = await result.text;
      const steps = await result.steps;

      assert.strictEqual(requests, 2);
      assert.strictEqual(text, "Review posted.");
      assert.strictEqual(steps[0].usage.inputTokens, 1);
      assert.strictEqual(steps[0].usage.outputTokens, 1);
      assert.strictEqual(steps[0].toolCalls[0].toolName, "github__addPullRequestComment");
      assert.deepEqual(steps[0].toolCalls[0].input, input);
    },
  );
});
