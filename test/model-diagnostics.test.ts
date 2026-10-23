import { assert, afterEach, test, vi } from "vitest";
import { z } from "zod";
import { APICallError } from "ai";
import { reviewModel } from "@/model";

type FixtureDelta =
  | { reasoning_content: string }
  | { content: string }
  | {
      tool_calls: {
        index: number;
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { [key: string]: never };

const summary = z.object({
  event: z.literal("model.stream.settled"),
  callId: z.uuid(),
  outcome: z.enum(["completed", "truncated", "interrupted", "error"]),
  providerReadyMs: z.number(),
  firstReasoningMs: z.number(),
  firstTextMs: z.number().optional(),
  firstToolInputMs: z.number().optional(),
  reasoningCharacters: z.number(),
  textCharacters: z.number(),
  toolInputCharacters: z.number(),
  responseModelId: z.string(),
  responseId: z.string(),
  sawFinish: z.boolean(),
});

afterEach(() => {
  vi.useRealTimers();
});

test.each(["complete", "disconnect", "in-band error", "consumer cancel"])(
  "stream diagnostics preserve provider behavior without content (%s)",
  async (mode) => {
    vi.useFakeTimers();
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let cancelled = false;
    const encoder = new TextEncoder();
    const privateReasoning = "Private reasoning text";
    const privateText = "Private answer text";
    const privateInput = '{"private":"tool input"}';
    const socketError = new Error("Private socket error");

    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              function send(delta: FixtureDelta, finishReason: string | null = null) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      id: "response-123",
                      created: 1,
                      model: "served-model",
                      choices: [{ index: 0, delta, finish_reason: finishReason }],
                    })}\n\n`,
                  ),
                );
              }

              setTimeout(() => send({ reasoning_content: privateReasoning }), 1_000);

              if (mode === "consumer cancel") {
                return;
              }

              setTimeout(() => {
                if (mode === "disconnect") {
                  controller.error(socketError);

                  return;
                }

                if (mode === "in-band error") {
                  controller.enqueue(
                    encoder.encode(
                      'data: {"error":{"message":"Private provider error","type":"stream_error"}}\n\n',
                    ),
                  );
                  controller.close();

                  return;
                }

                send({ content: privateText });
              }, 2_000);

              if (mode !== "complete") {
                return;
              }

              setTimeout(
                () =>
                  send({
                    tool_calls: [
                      {
                        index: 0,
                        id: "tool-123",
                        type: "function",
                        function: { name: "private_tool_name", arguments: privateInput },
                      },
                    ],
                  }),
                3_000,
              );
              setTimeout(() => {
                send({}, "tool_calls");
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              }, 4_000);
            },
            cancel() {
              cancelled = true;
            },
          });

          setTimeout(
            () =>
              resolve(new Response(stream, { headers: { "content-type": "text/event-stream" } })),
            200,
          );
        }),
    );

    const pending = reviewModel.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "Private prompt" }] }],
    });

    await vi.advanceTimersByTimeAsync(200);
    const { stream } = await pending;
    let receivedReasoning = "";
    let receivedText = "";
    let receivedInput = "";
    let receivedError: unknown;

    const consumed = (async () => {
      try {
        for await (const part of stream) {
          if (part.type === "reasoning-delta") {
            receivedReasoning += part.delta;

            if (mode === "consumer cancel") {
              break;
            }
          } else if (part.type === "text-delta") {
            receivedText += part.delta;
          } else if (part.type === "tool-input-delta") {
            receivedInput += part.delta;
          } else if (part.type === "error") {
            receivedError = part.error;
          }
        }
      } catch (error) {
        receivedError = error;
      }
    })();

    await vi.advanceTimersByTimeAsync(3_800);
    await consumed;

    const lines = output.mock.calls.map(([line]) => String(line));
    const settled = lines.filter((line) => line.includes('"event":"model.stream.settled"'));
    assert.lengthOf(settled, 1);
    const record = summary.parse(JSON.parse(settled[0] ?? "null"));
    assert.strictEqual(receivedReasoning, privateReasoning);
    assert.strictEqual(record.reasoningCharacters, privateReasoning.length);
    assert.strictEqual(record.providerReadyMs, 200);
    assert.strictEqual(record.firstReasoningMs, 1_000);
    assert.strictEqual(record.responseModelId, "served-model");
    assert.strictEqual(record.responseId, "response-123");
    assert.notInclude(lines.join(""), "Private");
    assert.notInclude(lines.join(""), "private");

    if (mode === "complete") {
      assert.strictEqual(receivedText, privateText);
      assert.strictEqual(receivedInput, privateInput);
      assert.strictEqual(record.outcome, "completed");
      assert.strictEqual(record.firstTextMs, 2_000);
      assert.strictEqual(record.firstToolInputMs, 3_000);
      assert.strictEqual(record.textCharacters, privateText.length);
      assert.strictEqual(record.toolInputCharacters, privateInput.length);
      assert.isTrue(record.sawFinish);
    } else {
      assert.strictEqual(record.outcome, mode === "in-band error" ? "error" : "interrupted");
      assert.isFalse(record.sawFinish);

      if (mode === "consumer cancel") {
        assert.isTrue(cancelled);
      } else {
        assert.isDefined(receivedError);
      }

      if (mode === "disconnect") {
        assert.isTrue(APICallError.isInstance(receivedError));

        if (APICallError.isInstance(receivedError)) {
          assert.strictEqual(receivedError.cause, socketError);
        }
      }
    }
  },
);
