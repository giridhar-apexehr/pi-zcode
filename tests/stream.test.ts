// Regression tests for the silent-failure bug: `zcode/glm-5.3-flash` on the
// aggregate base provider showed "Working" for a few seconds and then ended with no
// response and no error.
//
// Root causes covered here:
//   1. the aggregate base `zcode` provider routed every model to the Start Plan proxy,
//      even for an account holding only an Individual Plan;
//   2. Individual Plan was sent to the generic pay-as-you-go /api/paas/v4 endpoint,
//      which a subscription-only account cannot use (1113 / 1210);
//   3. a 200 response carrying a JSON error envelope (no SSE `data:` lines) ended as
//      stopReason="stop" with zero content -- a silent, empty "success";
//   4. likewise for a stream that never yielded a delta.
//
// Note on (3): #2 upstream already guards a JSON content-type before the parser runs.
// This suite pins the catch-all instead -- the no-content guard -- so the failure is
// reported even when the body is labelled as an event stream. The two do not overlap.
//
// No network: globalThis.fetch is stubbed with a hand-rolled response object (not
// `new Response(string)` -- importing this extension pulls in happy-dom, which
// replaces globals and breaks Response construction).
//
// Known gap: the Start Plan route cannot be tested here without also driving the
// headless CAPTCHA solver (network + happy-dom), so start-plan routing itself has no
// test seam. Two consequences are therefore untested:
//   - `resolvePlanFromModel` returning START_PLAN for a `zcode-start-plan` provider;
//   - the unregistered fallback (no plan recorded, no active plans) still defaulting
//     to START_PLAN. That fallback is safe only because the empty-stream guard now
//     reports an error instead of ending in silence.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as zcodeStream from "../src/stream/stream.js";

const { streamZCode } = zcodeStream;

// Imported off the namespace on purpose: a named import would fail at link time on
// unfixed code, so the tests would prove only that an export is missing rather than
// that the routing and error-surfacing behaviour is wrong.
function registerPlan(modelIds: string[], plan: string): void {
  const register = (zcodeStream as Record<string, unknown>).registerBaseProviderModelPlans;
  if (typeof register === "function")
    (register as (a: string[], b: string) => void)(modelIds, plan);
}

function clearPlans(): void {
  const clear = (zcodeStream as Record<string, unknown>).clearBaseProviderModelPlans;
  if (typeof clear === "function") (clear as () => void)();
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearPlans();
});

const API_KEY = JSON.stringify({
  access: "test-access-token",
  businessAccessToken: "test-business-token",
  providerSource: "zai",
  zcodeJwtToken: "test-jwt",
});

function makeModel(provider: string, id = "glm-5.3-flash") {
  return {
    api: "zcode",
    contextWindow: 1_000_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id,
    input: ["text", "image"],
    maxTokens: 16_384,
    name: id,
    baseUrl: "https://api.z.ai",
    provider,
    reasoning: true,
    thinkingLevelMap: {
      high: "high",
      low: "low",
      medium: "medium",
      minimal: "low",
      xhigh: "high",
    },
  } as never;
}

const context = {
  systemPrompt: "You are a helpful assistant.",
  messages: [{ role: "user", content: "Reply with exactly: PONG" }],
};

interface FakeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

function fakeResponse(body: string, status: number, contentType: string): FakeResponse {
  const encoder = new TextEncoder();
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    text: async () => body,
  };
}

const SSE_REPLY =
  'data: {"choices":[{"delta":{"content":"PONG"}}]}\n\n' +
  'data: {"choices":[{"finish_reason":"stop"}]}\n\n' +
  "data: [DONE]\n\n";

function textOf(content?: { type: string; text?: string }[]): string {
  return (content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

interface Outcome {
  urls: string[];
  types: string[];
  text: string;
  error?: string;
}

async function drive(
  provider: string,
  makeResponse: () => FakeResponse,
  id?: string,
): Promise<Outcome> {
  const urls: string[] = [];
  // A fresh body per call: the Start Plan route fetches CAPTCHA config first, and a
  // single shared body stream would be consumed twice and fail for the wrong reason.
  globalThis.fetch = (async (input: unknown) => {
    urls.push(typeof input === "string" ? input : (input as { url: string }).url);
    return makeResponse();
  }) as typeof globalThis.fetch;

  const out: Outcome = { urls, types: [], text: "" };
  const stream = streamZCode(
    makeModel(provider, id),
    context as never,
    {
      apiKey: API_KEY,
      maxRetries: 0,
    } as never,
  );
  for await (const ev of stream) {
    out.types.push(ev.type);
    // `done` carries the finished message; `error` carries the partial one.
    const e = ev as {
      message?: { content?: { type: string; text?: string }[] };
      error?: { errorMessage?: string; content?: { type: string; text?: string }[] };
    };
    if (ev.type === "error") {
      out.error = e.error?.errorMessage;
      out.text = textOf(e.error?.content);
    }
    if (ev.type === "done") {
      out.text = textOf(e.message?.content);
    }
  }
  return out;
}

test("base zcode provider sends an Individual Plan model to the coding endpoint", async () => {
  // Mirror detectAndRegisterPlans(): an Individual-Plan-only account records the plan
  // that granted the model, and pi runs that on every startup.
  registerPlan(["glm-5.3-flash"], "individual-plan");
  const out = await drive("zcode", () => fakeResponse(SSE_REPLY, 200, "text/event-stream"));
  assert.equal(out.error, undefined, out.error ?? "unexpected error");
  assert.equal(out.text, "PONG");
  assert.match(out.urls[0], /\/api\/coding\/paas\/v4\/chat\/completions$/);
  // The generic pay-as-you-go path answers 1113/1210 for subscription-only accounts.
  assert.doesNotMatch(out.urls[0], /(?<!coding)\/api\/paas\/v4\//);
});

test("explicit zcode-individual-plan provider uses the same coding endpoint", async () => {
  const out = await drive("zcode-individual-plan", () =>
    fakeResponse(SSE_REPLY, 200, "text/event-stream"),
  );
  assert.equal(out.text, "PONG");
  assert.match(out.urls[0], /\/api\/coding\/paas\/v4\/chat\/completions$/);
});

test("a 200 carrying a JSON error envelope is reported, not silently empty", async () => {
  // Route onto the Individual Plan endpoint so no CAPTCHA solver is involved.
  registerPlan(["glm-5.3-flash"], "individual-plan");
  const out = await drive("zcode", () =>
    fakeResponse('{"code":1005,"msg":"exceed quota limit","logid":"abc"}', 200, "application/json"),
  );
  assert.equal(out.types.includes("done"), false, "must not report a successful empty turn");
  assert.ok(out.error, "must surface an error");
  assert.match(out.error, /balance|quota|plan/i);
});

test("an SSE stream that never yields a delta is reported, not silently empty", async () => {
  // Route onto the Individual Plan endpoint so no CAPTCHA solver is involved.
  registerPlan(["glm-5.3-flash"], "individual-plan");
  const out = await drive("zcode", () =>
    fakeResponse(": keep-alive\n\n", 200, "text/event-stream"),
  );
  assert.equal(out.types.includes("done"), false, "must not report a successful empty turn");
  assert.match(out.error ?? "", /no content/i);
});

test("a model id granted by the Individual Plan routes there from the base provider", async () => {
  // Same id registered for another plan must not shadow the recorded grant.
  registerPlan(["glm-4.5"], "individual-plan");
  const out = await drive(
    "zcode",
    () => fakeResponse(SSE_REPLY, 200, "text/event-stream"),
    "glm-4.5",
  );
  assert.match(out.urls[0], /\/api\/coding\/paas\/v4\/chat\/completions$/);
});
/**
 * Individual Plan is the OpenAI-shaped `/api/coding/paas/v4/chat/completions`, so the
 * request body must be OpenAI-shaped too. Emitting Anthropic parts is rejected with
 * 1214 "messages[N].content[M].type type error" (or "tools[0].type:type cannot be
 * empty"), which is what a real conversation with any tool call runs into.
 */
test("Individual Plan sends OpenAI-shaped tools, not Anthropic input_schema", async () => {
  registerPlan(["glm-5.3"], "individual-plan");
  let sent: any;
  globalThis.fetch = (async (_i: unknown, init: any) => {
    sent = JSON.parse(String(init.body));
    return fakeResponse(SSE_REPLY, 200, "text/event-stream");
  }) as typeof globalThis.fetch;

  const stream = streamZCode(
    makeModel("zcode", "glm-5.3"),
    {
      ...context,
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    } as never,
    { apiKey: API_KEY, maxRetries: 0 } as never,
  );
  for await (const _ev of stream) {
    // drain
  }

  assert.ok(sent, "a request must have been sent");
  assert.equal(sent.tools[0].type, "function");
  assert.equal(sent.tools[0].function.name, "read");
  assert.deepEqual(sent.tools[0].function.parameters, {
    type: "object",
    properties: { path: { type: "string" } },
  });
  assert.equal(sent.tools[0].input_schema, undefined, "must not send Anthropic input_schema");
});

test("Individual Plan sends OpenAI-shaped tool calls and tool results", async () => {
  registerPlan(["glm-5.3"], "individual-plan");
  let sent: any;
  globalThis.fetch = (async (_i: unknown, init: any) => {
    sent = JSON.parse(String(init.body));
    return fakeResponse(SSE_REPLY, 200, "text/event-stream");
  }) as typeof globalThis.fetch;

  const withHistory = {
    systemPrompt: "You are a helpful assistant.",
    messages: [
      { role: "user", content: [{ type: "text", text: "Read foo.txt" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me read it." },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "foo.txt" } },
        ],
      },
      { role: "toolResult", toolCallId: "call_1", content: "hello from the file" },
      { role: "user", content: "Summarise it in 3 words." },
    ],
  };

  const stream = streamZCode(
    makeModel("zcode", "glm-5.3"),
    withHistory as never,
    {
      apiKey: API_KEY,
      maxRetries: 0,
    } as never,
  );
  for await (const _ev of stream) {
    // drain
  }

  const msgs = sent.messages;
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[0].content[0].type, "text");

  // assistant turn: plain string content plus tool_calls
  assert.equal(msgs[1].role, "assistant");
  assert.equal(msgs[1].content, "Let me read it.");
  assert.equal(msgs[1].tool_calls[0].type, "function");
  assert.equal(msgs[1].tool_calls[0].id, "call_1");
  assert.equal(msgs[1].tool_calls[0].function.name, "read");
  assert.deepEqual(JSON.parse(msgs[1].tool_calls[0].function.arguments), { path: "foo.txt" });
  assert.equal(typeof msgs[1].content, "string", "assistant content must be a plain string");

  // tool result: standalone role:"tool" message, not a user part array
  assert.equal(msgs[2].role, "tool");
  assert.equal(msgs[2].tool_call_id, "call_1");
  assert.equal(msgs[2].content, "hello from the file");

  // no part anywhere may use an Anthropic-only type
  for (const m of msgs) {
    if (Array.isArray(m.content)) {
      for (const p of m.content) {
        assert.ok(
          p.type === "text" || p.type === "image_url",
          `unexpected part type ${JSON.stringify(p.type)} in message role=${m.role}`,
        );
      }
    }
  }
});
