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

interface FetchOptions {
  readonly body?: string;
}

interface ProviderRequest {
  readonly url: string;
  readonly body: unknown;
}

await test("assessment sends the patch through the Railway route and validates structured output", async () => {
  const { mock } = await import("node:test");
  const { assess } = await import("@/review");
  const { snapshot } = await import("./fixtures.js");
  const previousKey = process.env.FREELLM_API_KEY;
  process.env.FREELLM_API_KEY = "test-key";
  const requests: ProviderRequest[] = [];

  let content = JSON.stringify({
    decision: "hold",
    reason: "Regression risk",
    risks: ["Missing test"],
  });

  const mockedFetch = mock.method(globalThis, "fetch", (input: string, init?: FetchOptions) => {
    requests.push({ url: input, body: JSON.parse(z.string().parse(init?.body)) });

    return Promise.resolve(
      Response.json({
        id: "fixture",
        object: "chat.completion",
        created: 1,
        model: "auto",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    );
  });

  try {
    const pr = snapshot();
    assert.deepEqual(await assess(pr), {
      decision: "hold",
      reason: "Regression risk",
      risks: ["Missing test"],
    });
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].url,
      "https://freellmapi-production-1175.up.railway.app/v1/chat/completions",
    );

    const body = z
      .object({
        model: z.string(),
        provider: z.unknown().optional(),
        messages: z.array(z.object({ role: z.string(), content: z.string() })),
        response_format: z.object({ type: z.string() }),
      })
      .parse(requests[0].body);

    assert.equal(body.model, reviewModel.modelId);
    assert.equal(body.provider, undefined);
    assert.equal(body.response_format.type, "json_schema");
    assert.ok(
      body.messages.some(
        (message) =>
          message.role === "system" && message.content.includes("untrusted repository data"),
      ),
    );
    assert.ok(
      body.messages.some(
        (message) =>
          message.role === "user" &&
          message.content === JSON.stringify({ title: pr.title, body: pr.body, files: pr.files }),
      ),
    );

    content = JSON.stringify({ decision: "merge" });
    await assert.rejects(assess(pr));
  } finally {
    mockedFetch.mock.restore();

    if (previousKey === undefined) {
      delete process.env.FREELLM_API_KEY;
    } else {
      process.env.FREELLM_API_KEY = previousKey;
    }
  }
});
