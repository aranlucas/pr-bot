import assert from "node:assert/strict";
import { test } from "node:test";
import { generateText, tool } from "ai";
import { z } from "zod";
import { reviewModel } from "@/model";
import { commentSchema } from "@/review";

interface TestRequest {
  readonly body?: string;
}

await test("the main model can call post-comment without a separate structured review request", async (t) => {
  const input = { reviewId: "a".repeat(64), body: "No concrete defects found." };
  let requests = 0;

  t.mock.method(globalThis, "fetch", (url: string, init?: TestRequest) => {
    assert.equal(url, "https://freellmapi-production-1175.up.railway.app/v1/chat/completions");
    requests++;
    const request = z.object({ body: z.string() }).parse(init);

    const body = z
      .object({
        model: z.string(),
        response_format: z.unknown().optional(),
        tools: z.array(z.object({ type: z.string(), function: z.object({ name: z.string() }) })),
      })
      .parse(JSON.parse(request.body));

    assert.equal(body.model, "auto");
    assert.equal(body.response_format, undefined);
    assert.equal(body.tools[0].function.name, "post-comment");

    return Promise.resolve(
      Response.json({
        id: "review-test",
        object: "chat.completion",
        created: 1,
        model: "auto",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "comment-call",
                  type: "function",
                  function: { name: "post-comment", arguments: JSON.stringify(input) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });

  const result = await generateText({
    model: reviewModel,
    tools: { "post-comment": tool({ description: "Post the review", inputSchema: commentSchema }) },
    prompt: "Review this test change and post your findings",
    maxRetries: 0,
  });

  assert.equal(requests, 1);
  assert.equal(result.toolCalls[0].toolName, "post-comment");
  assert.deepEqual(result.toolCalls[0].input, input);
});
