import { assert, test, vi } from "vitest";
import { generateText, tool, ToolLoopAgent } from "ai";
import { z } from "zod";
import { reviewModel } from "@/model";

test.each([false, true])(
  "the main model identifies PR Bot and calls the native GitHub comment tool (tool loop: %s)",
  async (useToolLoop) => {
    const input = {
      owner: "acme",
      repo: "app",
      pullNumber: 42,
      body: "No concrete defects found.",
    };

    let requests = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      assert.strictEqual(
        url,
        "https://freellmapi-production-1175.up.railway.app/v1/chat/completions",
      );
      const headers = new Headers(init?.headers);
      const userAgent = z.string().parse(headers.get("user-agent"));
      assert.ok(userAgent.startsWith("pr-bot (Eve agent; OpenAI-compatible) "));
      assert.match(userAgent, /\bai\//);

      if (useToolLoop) {
        assert.ok(userAgent.includes("ai-sdk-agent/tool-loop"));
      }

      assert.strictEqual(headers.get("content-type"), "application/json");
      requests++;
      const request = z.object({ body: z.string() }).parse(init);

      const body = z
        .object({
          model: z.string(),
          response_format: z.unknown().optional(),
          tools: z.array(z.object({ type: z.string(), function: z.object({ name: z.string() }) })),
        })
        .parse(JSON.parse(request.body));

      assert.strictEqual(body.model, "auto");
      assert.strictEqual(body.response_format, undefined);
      assert.strictEqual(body.tools[0].function.name, "github__addPullRequestComment");

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
                    function: {
                      name: "github__addPullRequestComment",
                      arguments: JSON.stringify(input),
                    },
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
        }),
      },
      maxRetries: 0,
    };

    const prompt = "Review this test change and post your findings";

    const result = useToolLoop
      ? await new ToolLoopAgent(settings).generate({ prompt })
      : await generateText({ ...settings, prompt });

    assert.strictEqual(requests, 1);
    assert.strictEqual(result.toolCalls[0].toolName, "github__addPullRequestComment");
    assert.deepEqual(result.toolCalls[0].input, input);
  },
);
