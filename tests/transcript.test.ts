import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Context, Tool } from "@earendil-works/pi-ai";
import { getToolStateChanges, normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
  clearBaseProviderModelPlans,
  registerBaseProviderModelPlans,
  streamZCode,
} from "../src/stream/stream.js";
import { ZCodePlan } from "../src/types/enums.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearBaseProviderModelPlans();
});
const readTool: Tool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } } as never,
};
const changedTool: Tool = { ...readTool, description: "Read the entire file" };

for (const state of ["initial", "changed", "removed", "legacy override"] as const) {
  test(`normalized pi transcript preserves system prompt and ${state} tools`, async () => {
    const normalized = normalizeContext({
      systemPrompt: "Base instruction",
      tools: [readTool],
      messages: [{ role: "user", content: "Read fixture.txt", timestamp: 1 }],
    });
    let expectedTools = [readTool];
    if (state === "changed" || state === "removed") {
      expectedTools = state === "changed" ? [changedTool] : [];
      normalized.messages.push({
        role: "system",
        content: "Additional instruction",
        timestamp: 2,
        ...getToolStateChanges([readTool], expectedTools),
      });
    }
    const input: Context =
      state === "legacy override"
        ? { ...normalized, systemPrompt: "Explicit instruction", tools: [] }
        : normalized;
    let sent: Record<string, any> | undefined;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return {
        ok: true,
        status: 200,
        headers: { get: () => "text/event-stream" },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',
              ),
            );
            controller.close();
          },
        }),
      };
    }) as unknown as typeof globalThis.fetch;
    registerBaseProviderModelPlans(["glm-5.3"], ZCodePlan.INDIVIDUAL_PLAN);
    const model = {
      api: "zcode",
      provider: "zcode",
      id: "glm-5.3",
      name: "GLM",
      baseUrl: "https://api.z.ai",
      contextWindow: 100000,
      maxTokens: 1024,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    for await (const event of streamZCode(model as never, input, {
      apiKey: JSON.stringify({ access: "test-token", providerSource: "zai" }),
    })) {
      assert.notEqual(event.type, "error", "Request must succeed");
    }
    assert.ok(sent);
    assert.deepEqual(
      sent.messages,
      [
        {
          role: "system",
          content:
            state === "legacy override"
              ? "Explicit instruction"
              : state === "initial"
                ? "Base instruction"
                : "Base instruction\n\nAdditional instruction",
        },
        { role: "user", content: "Read fixture.txt" },
      ],
      "Emit one resolved system prompt, not duplicate transcript system messages",
    );
    assert.deepEqual(
      sent.tools ?? [],
      (state === "legacy override" ? [] : expectedTools).map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
      "Send the current tool declaration, never stale/removed tools",
    );
  });
}
