import assert from "node:assert/strict";
import { test } from "node:test";
import { generateText, Output } from "ai";
import { z } from "zod";
import { reviewModel } from "@/model";

interface TestRequest {
  readonly body?: string;
}

await test("Railway reviews send structured output without OpenRouter routing options", async (t) => {
  t.mock.method(globalThis, "fetch", (input: string, init?: TestRequest) => {
    assert.equal(
      z.string().parse(input),
      "https://freellmapi-production-1175.up.railway.app/v1/chat/completions",
    );
    const request = z.object({ body: z.string() }).parse(init);

    const body = z
      .object({
        model: z.string(),
        provider: z.unknown().optional(),
        response_format: z.unknown(),
      })
      .parse(JSON.parse(request.body));

    assert.equal(body.model, "auto");
    assert.equal(body.provider, undefined);
    assert.deepEqual(body.response_format, {
      type: "json_schema",
      json_schema: {
        name: "response",
        strict: true,
        schema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: { decision: { type: "string" } },
          required: ["decision"],
          additionalProperties: false,
        },
      },
    });

    return Promise.resolve(
      Response.json({
        id: "review-test",
        object: "chat.completion",
        created: 1,
        model: "auto",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: '{"decision":"hold"}' },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });

  const result = await generateText({
    model: reviewModel,
    output: Output.object({ schema: z.object({ decision: z.string() }) }),
    prompt: "Review this test change",
    maxRetries: 0,
  });

  assert.deepEqual(result.output, { decision: "hold" });
});
