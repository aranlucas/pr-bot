import { assert, describe, test, vi } from "vitest";
import { generateText, isStepCount, streamText, tool, ToolLoopAgent } from "ai";
import { z } from "zod";

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
            response_format: z.unknown().optional(),
            tools: z.array(
              z.object({ type: z.string(), function: z.object({ name: z.string() }) }),
            ),
          })
          .parse(JSON.parse(request.body));

        assert.strictEqual(body.model, "auto");
        assert.strictEqual(body.stream ?? false, streaming);
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
      assert.strictEqual(steps[0].toolCalls[0].toolName, "github__addPullRequestComment");
      assert.deepEqual(steps[0].toolCalls[0].input, input);
    },
  );
});
