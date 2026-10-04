import crypto from "node:crypto";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  acquireCaptchaVerifyParam,
  buildStartPlanHeaders,
  buildZCodeHeaders,
  getOrSolveCaptchaParam,
  getStagedCaptchaParam,
  parseApiKey,
  resolveBaseHost,
  solveCaptchaHeadless,
} from "../client/index.js";
import {
  setLastEndpoint,
  setLastError,
  setLastLatencyMs,
  setLastRequestId,
  setLastResolvedRuntimeModel,
  setLastStatus,
} from "../diagnostics/diagnostics.js";
import { ZCodePlan } from "../types/enums.js";
import { ZCODE_API } from "../types/types.js";
import { redactSecrets } from "../utils/security.js";
import { zcodeEnv } from "../utils/util.js";
import { buildZCodeStartPlanSystem } from "./system-prompt.js";

export { ZCODE_API } from "../types/types.js";

const MAX_TRANSIENT_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

/** Modes we never retry without action (auth / hard risk control). */
const NON_RETRYABLE_PATTERN =
  /3001|401|403|invalid api key|token expired|authentication failed|parameter error/i;

function friendlyZCodeError(status: number | undefined, text: string): string {
  const msg = redactSecrets(text).slice(0, 500);
  if (/context_length_exceeded|maximum context length/i.test(msg)) {
    return `context_length_exceeded: ${msg}`;
  }
  if (/3007|captcha verify failed/i.test(msg)) {
    return `Captcha verification failed for Start Plan. Please check network connection or retry.`;
  }
  if (/3009|3010|concurrency limit|system is busy/i.test(msg)) {
    return `Start Plan model is currently busy or concurrency limit reached. Please retry shortly.`;
  }
  if (/3012|unusual activity/i.test(msg)) {
    return `ZCode gateway check rejected request. Please check /zcode.doctor.`;
  }
  if (/1113|insufficient balance|arrear|no resource package/i.test(msg)) {
    return `Insufficient balance or no active plan for this model. Run /login zcode to refresh.`;
  }
  if (/1005|exceed quota|quota limit/i.test(msg)) {
    return `Start Plan quota exceeded for this model (upstream 1005: exceed quota limit) — the model may not be in your plan's entitlement, or the shared quota is temporarily exhausted. Try glm-5.3-flash, or check /zcode.usage.`;
  }
  if (/1004|1000|invalid api key|token expired|authentication failed/i.test(msg)) {
    return `Authentication failed. Run /login zcode to re-authenticate.`;
  }
  if (/1305|overloaded/i.test(msg)) {
    return `The model is currently overloaded. Please retry in a few moments.`;
  }
  if (/1211|model not found/i.test(msg)) {
    return `Model is not available or not enabled for this account.`;
  }
  if (status === 400) {
    return `Request rejected (${msg}). Please verify model parameters.`;
  }
  if (status === 401) {
    return "Authentication failed. Next: run /login zcode.";
  }
  if (status === 403) {
    return `Access denied (${msg}). Next: check account entitlement.`;
  }
  if (status === 429) {
    return `Rate limit exceeded. Please wait a moment and retry.`;
  }
  if (status && status >= 500) {
    return `Server error (${status}: ${msg}). Next: retry in a moment.`;
  }
  return msg || "Unknown API error";
}

function convertTools(
  tools: Tool[] | undefined,
  isStartPlan: boolean,
): Record<string, unknown>[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  if (!isStartPlan) {
    // The coding/paas endpoint speaks the OpenAI tool schema. Sending Anthropic's
    // {name, description, input_schema} is rejected with
    // 1214 "tools[0].type:type cannot be empty" on every tool-bearing request.
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

function convertMessages(context: Context, isStartPlan = false): Record<string, unknown>[] {
  return isStartPlan ? convertMessagesAnthropic(context) : convertMessagesOpenAI(context);
}

/**
 * Wire format for the Individual Plan endpoint (`/api/coding/paas/v4/chat/completions`),
 * which is OpenAI-shaped: tool calls live on `assistant.tool_calls` and results are
 * standalone `{role:"tool"}` messages. Emitting Anthropic parts (`tool_use`,
 * `tool_result` inside a user message) is rejected with
 * 1214 "messages[N].content[M].type type error".
 */
function convertMessagesOpenAI(context: Context): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];

  for (const message of context.messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        messages.push({ role: "user", content: message.content });
      } else if (Array.isArray(message.content)) {
        const parts: Record<string, unknown>[] = [];
        for (const part of message.content) {
          if (part.type === "text") {
            parts.push({ type: "text", text: part.text });
          } else if (part.type === "image") {
            parts.push({
              type: "image_url",
              image_url: { url: `data:${part.mimeType};base64,${part.data}` },
            });
          }
        }
        messages.push({ role: "user", content: parts });
      }
    } else if (message.role === "assistant") {
      let text = "";
      const toolCalls: Record<string, unknown>[] = [];
      if (typeof message.content === "string") {
        text = message.content;
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "text" && part.text) {
            text += part.text;
          } else if (part.type === "toolCall") {
            toolCalls.push({
              id: part.id,
              type: "function",
              function: {
                name: part.name,
                arguments: JSON.stringify(part.arguments ?? {}),
              },
            });
          }
        }
      }
      // `content` must stay a string here; a tool-call turn carries it alongside tool_calls.
      messages.push({
        role: "assistant",
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    } else if (message.role === "toolResult") {
      let contentStr = "";
      if (typeof message.content === "string") {
        contentStr = message.content;
      } else if (Array.isArray(message.content)) {
        contentStr = message.content
          .filter((p) => p.type === "text")
          .map((p) => (p as TextContent).text)
          .join("\n");
      }
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: contentStr,
      });
    }
  }

  return messages;
}

function convertMessagesAnthropic(context: Context): Record<string, unknown>[] {
  // Only ever used for Start Plan, where prompt caching markers are wanted.
  const cacheControl = { cache_control: { type: "ephemeral" } };
  const messages: Record<string, unknown>[] = [];

  for (const message of context.messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        messages.push({
          role: "user",
          content: message.content,
          ...cacheControl,
        });
      } else if (Array.isArray(message.content)) {
        const parts: Record<string, unknown>[] = [];
        for (const part of message.content) {
          if (part.type === "text") {
            parts.push({
              type: "text",
              text: part.text,
              ...cacheControl,
            });
          } else if (part.type === "image") {
            parts.push({
              type: "image",
              source: {
                type: "base64",
                media_type: part.mimeType,
                data: part.data,
              },
            });
          }
        }
        messages.push({ role: "user", content: parts });
      }
    } else if (message.role === "assistant") {
      const parts: Record<string, unknown>[] = [];
      if (typeof message.content === "string") {
        if (message.content) parts.push({ type: "text", text: message.content });
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === "text" && part.text) {
            parts.push({ type: "text", text: part.text });
          } else if (part.type === "toolCall") {
            parts.push({
              type: "tool_use",
              id: part.id,
              name: part.name,
              input: part.arguments,
            });
          }
        }
      }
      messages.push({ role: "assistant", content: parts });
    } else if (message.role === "toolResult") {
      let contentStr = "";
      if (typeof message.content === "string") {
        contentStr = message.content;
      } else if (Array.isArray(message.content)) {
        contentStr = message.content
          .filter((p) => p.type === "text")
          .map((p) => (p as TextContent).text)
          .join("\n");
      }

      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: contentStr,
          },
        ],
      });
    }
  }

  return messages;
}

function resolveEndpointForPlan(
  plan: ZCodePlan,
  model: Model<Api>,
  auth: ReturnType<typeof parseApiKey>,
): string {
  const explicit = zcodeEnv("BASE_URL")?.trim();
  if (explicit && plan !== ZCodePlan.START_PLAN) {
    return explicit.endsWith("/chat/completions")
      ? explicit
      : `${explicit.replace(/\/+$/, "")}/api/paas/v4/chat/completions`;
  }

  // Start Plan goes through the ZCode shared plan proxy.
  if (plan === ZCodePlan.START_PLAN) {
    return "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages";
  }

  // A model.baseUrl that already names a full endpoint is honoured as-is.
  if (model.baseUrl?.endsWith("/chat/completions")) {
    return model.baseUrl;
  }

  // Individual Plan is billed against the coding subscription, which is served by the
  // /api/coding/paas path. The generic /api/paas path is pay-as-you-go: a
  // subscription-only account gets 1113 "insufficient balance" and 1210 "thinking
  // cannot be disabled" there, while the coding path serves the same model fine.
  const host = resolveBaseHost(auth);
  return `${host}/api/coding/paas/v4/chat/completions`;
}

function buildRequestHeaders(
  plan: ZCodePlan,
  auth: ReturnType<typeof parseApiKey>,
  captcha?: { param: string; region: string },
): Record<string, string> {
  if (plan === ZCodePlan.START_PLAN) {
    const sessionId = crypto.randomUUID();
    const traceId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const queryId = `01a0${crypto.randomBytes(14).toString("hex")}`;

    const extra: Record<string, string> = {
      "x-zcode-agent": "glm",
      "x-release-channel": "production",
      "x-client-language": "zh-CN",
      "x-request-id": requestId,
      "x-zcode-session-type": "main",
      "x-zcode-trace-id": traceId,
      "x-query-id": queryId,
      "x-session-id": sessionId,
    };

    const effectiveCaptcha = captcha || getStagedCaptchaParam();
    if (effectiveCaptcha?.param) {
      extra["x-aliyun-captcha-verify-param"] = effectiveCaptcha.param;
      if (effectiveCaptcha.region) {
        extra["x-aliyun-captcha-verify-region"] = effectiveCaptcha.region;
      }
    }
    return buildStartPlanHeaders(auth, extra);
  }
  return buildZCodeHeaders(auth);
}

function buildRequestBody({
  model,
  context,
  options,
  plan,
}: {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions | undefined;
  plan: ZCodePlan;
}): Record<string, unknown> {
  if (plan === ZCodePlan.START_PLAN) {
    const system = buildZCodeStartPlanSystem(context.systemPrompt, model.id);
    const messages = convertMessages(context, true);
    const tools = convertTools(context.tools, true);

    const body: Record<string, unknown> = {
      model: model.id,
      max_tokens: model.maxTokens || 128000,
      system,
      messages,
      stream: true,
      temperature: options?.temperature ?? 0.7,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = { type: "auto" };
    }

    if (model.reasoning) {
      body.thinking = { type: "enabled", budget_tokens: 8000 };
      body.output_config = { effort: "low" };
    }

    return body;
  }

  // Standard PaaS chat completions format
  const body: Record<string, unknown> = {
    model: model.id,
    messages: convertMessages(context, false),
    max_tokens: model.maxTokens || 4096,
    stream: true,
    temperature: options?.temperature ?? 0.7,
  };

  const tools = convertTools(context.tools, false);
  if (tools) body.tools = tools;
  if (model.reasoning && options?.reasoning) {
    body.reasoning_effort = model.thinkingLevelMap?.[options.reasoning] || "medium";
  }

  return body;
}

/**
 * Extract a readable message from a ZCode JSON error envelope.
 * Returns undefined when the payload is not an error envelope (e.g. an SSE body).
 */
function parseErrorEnvelope(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      code?: number | string;
      msg?: string;
      error?: { code?: number | string; message?: string } | string;
    };
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
    if (parsed.error === undefined && parsed.code === undefined) {
      return undefined;
    }
    const message = parsed.error?.message ?? parsed.msg;
    const code = parsed.error?.code ?? parsed.code;
    return (
      [message, code].filter((v) => v !== undefined && v !== null && v !== "").join(" | ") ||
      undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * Plan routing for models exposed on the aggregate base `zcode` provider.
 * `detectAndRegisterPlans` records which plan actually granted each model id, so the
 * stream never guesses. Without this an account holding only an Individual Plan sends
 * every base-provider model to the Start Plan proxy, which answers HTTP 200 with an
 * error envelope and no stream — which reads as an empty, successful turn.
 */
const baseProviderModelPlans = new Map<string, ZCodePlan>();
let activePlans: ZCodePlan[] = [];

/** Record which plans this account actually holds, for routing fallbacks. */
export function setActivePlans(plans: ZCodePlan[]): void {
  activePlans = plans;
}

/** Record which plan granted each model id exposed on the base `zcode` provider. */
export function registerBaseProviderModelPlans(modelIds: string[], plan: ZCodePlan): void {
  for (const id of modelIds) {
    // First plan to claim an id wins; an id granted by both stays ambiguous and
    // falls back to the default below.
    if (!baseProviderModelPlans.has(id)) {
      baseProviderModelPlans.set(id, plan);
    }
  }
}

/** Drop recorded routing, so a plan change (e.g. re-login) takes effect immediately. */
export function clearBaseProviderModelPlans(): void {
  baseProviderModelPlans.clear();
}

function isTransientRetryable(text: string): boolean {
  return (
    /1305|3009|3010|overloaded|concurrency limit|temporarily overloaded|429|529/i.test(text) &&
    !NON_RETRYABLE_PATTERN.test(text)
  );
}

/**
 * Native simple stream implementation for ZCode, dispatched by the model's plan.
 */
export function streamZCode(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const plan = resolvePlanFromModel(model);

  (async () => {
    const startTime = Date.now();
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: ZCODE_API,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    let textBlockIndex = -1;
    let thinkingBlockIndex = -1;
    const toolCallIndices = new Map<number, number>();
    const toolCallRawArgs = new Map<number, string>();

    try {
      const auth = parseApiKey(options?.apiKey);
      if (!auth.token && !auth.zcodeJwtToken) {
        throw new Error("Missing ZCode credentials. Run /login zcode first.");
      }

      const endpoint = resolveEndpointForPlan(plan, model, auth);
      setLastEndpoint(endpoint);
      setLastResolvedRuntimeModel(model.id);

      let captchaParam: { param: string; region: string } | undefined = undefined;
      if (plan === ZCodePlan.START_PLAN) {
        try {
          captchaParam = await getOrSolveCaptchaParam(auth.zcodeJwtToken);
        } catch {
          // background solve failed; continue with staged/empty and auto-recover on 3007
        }
      }

      let headers = buildRequestHeaders(plan, auth, captchaParam);
      const requestBody = buildRequestBody({ model, context, options, plan });

      stream.push({ type: "start", partial: output });

      let res: Response | undefined = undefined;
      let lastErrText = "";

      for (let attempt = 0; attempt < MAX_TRANSIENT_RETRIES; attempt++) {
        if (options?.signal?.aborted) {
          throw new Error("Request aborted");
        }
        if (attempt > 0) {
          const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
          await new Promise((r) => setTimeout(r, delay));
        }

        const candidateRes = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
          signal: options?.signal,
        });

        setLastStatus(candidateRes.status);
        const requestId = candidateRes.headers.get("x-request-id") || undefined;
        if (requestId) setLastRequestId(requestId);

        if (candidateRes.ok) {
          res = candidateRes;
          break;
        }

        lastErrText = await candidateRes.text().catch(() => "");

        // Auto-recover from 3007 (Captcha required on Start Plan) by solving headlessly in background
        if (
          /3007|captcha verify failed/i.test(lastErrText) &&
          plan === ZCodePlan.START_PLAN &&
          attempt === 0
        ) {
          try {
            const verified = await solveCaptchaHeadless(auth.zcodeJwtToken);
            if (verified?.captchaVerifyParam) {
              headers = buildRequestHeaders(plan, auth, {
                param: verified.captchaVerifyParam,
                region: verified.captchaRegion,
              });
              continue; // retry immediately with the fresh captcha header
            }
          } catch {
            // fallback
          }
        }

        if (isTransientRetryable(lastErrText) && attempt < MAX_TRANSIENT_RETRIES - 1) {
          continue;
        }

        const friendly = friendlyZCodeError(candidateRes.status, lastErrText);
        setLastError(friendly);
        setLastLatencyMs(Date.now() - startTime);
        throw new Error(friendly);
      }

      if (!res || !res.ok) {
        const friendly = friendlyZCodeError(res?.status, lastErrText);
        setLastError(friendly);
        setLastLatencyMs(Date.now() - startTime);
        throw new Error(friendly);
      }

      if (!res.body) {
        throw new Error("Empty response body received from API");
      }

      // Upstream sometimes signals business errors with HTTP 200 + a plain
      // JSON body (e.g. {"code":1005,"msg":"exceed quota limit"}) instead of
      // a non-2xx status or an SSE error event. The SSE parser below would
      // silently read zero events and misreport it as "stream ended without
      // a stop reason (content-filter cutoff)". Detect and surface it.
      const responseContentType = res.headers.get("content-type") ?? "";
      if (/json/i.test(responseContentType) && !/event-stream/i.test(responseContentType)) {
        const bodyText = await res.text();
        let errText = bodyText.slice(0, 1000) || "(empty JSON body)";
        try {
          const parsed = JSON.parse(bodyText) as { code?: number | string; msg?: string; message?: string };
          if (parsed && (parsed.code !== undefined || parsed.msg || parsed.message)) {
            errText = `${parsed.code ?? "unknown"} ${parsed.msg || parsed.message || ""}`.trim();
          }
        } catch {
          // Not JSON after all — surface the raw text.
        }
        const friendly = friendlyZCodeError(res.status, errText);
        setLastError(friendly);
        setLastLatencyMs(Date.now() - startTime);
        throw new Error(friendly);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let capturedBody = "";

      while (true) {
        if (options?.signal?.aborted) {
          output.stopReason = "aborted";
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        if (capturedBody.length < 4000) {
          capturedBody += buffer.slice(0, 4000 - capturedBody.length);
        }
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || line.startsWith(":") || line.startsWith("event:")) {
            continue;
          }

          if (line.startsWith("data:")) {
            const dataStr = line.slice(5).trim();
            if (dataStr === "[DONE]") continue;

            let chunk: Record<string, unknown> | undefined = undefined;
            try {
              chunk = JSON.parse(dataStr) as Record<string, unknown>;
            } catch {
              continue;
            }

            if (chunk.error) {
              const errObj = chunk.error as { message?: string };
              throw new Error(friendlyZCodeError(res.status, errObj.message || "Streaming error"));
            }

            // 1. Anthropic format events (content_block_delta, message_delta)
            if (chunk.type === "content_block_delta") {
              const delta = chunk.delta as
                { type?: string; text?: string; thinking?: string } | undefined;
              if (delta?.type === "text_delta" && delta.text) {
                if (textBlockIndex === -1) {
                  const block: TextContent = { type: "text", text: delta.text };
                  output.content.push(block);
                  textBlockIndex = output.content.length - 1;
                  stream.push({
                    type: "text_start",
                    contentIndex: textBlockIndex,
                    partial: output,
                  });
                } else {
                  const block = output.content[textBlockIndex] as TextContent;
                  block.text += delta.text;
                  stream.push({
                    type: "text_delta",
                    contentIndex: textBlockIndex,
                    delta: delta.text,
                    partial: output,
                  });
                }
              } else if (delta?.type === "thinking_delta" && delta.thinking) {
                if (thinkingBlockIndex === -1) {
                  const block: ThinkingContent = {
                    type: "thinking",
                    thinking: delta.thinking,
                  };
                  output.content.push(block);
                  thinkingBlockIndex = output.content.length - 1;
                  stream.push({
                    type: "thinking_start",
                    contentIndex: thinkingBlockIndex,
                    partial: output,
                  });
                } else {
                  const block = output.content[thinkingBlockIndex] as ThinkingContent;
                  block.thinking += delta.thinking;
                  stream.push({
                    type: "thinking_delta",
                    contentIndex: thinkingBlockIndex,
                    delta: delta.thinking,
                    partial: output,
                  });
                }
              }
            } else if (chunk.type === "message_delta") {
              const delta = chunk.delta as { stop_reason?: string } | undefined;
              if (delta?.stop_reason === "tool_use") output.stopReason = "toolUse";
              else if (delta?.stop_reason === "max_tokens") output.stopReason = "length";
              else output.stopReason = "stop";

              const usage = chunk.usage as { output_tokens?: number } | undefined;
              if (usage?.output_tokens) {
                output.usage.output = usage.output_tokens;
                output.usage.totalTokens = output.usage.input + output.usage.output;
                calculateCost(model, output.usage);
              }
            }

            // 2. OpenAI format events (choices[0].delta)
            const choices = chunk.choices as
              | Array<{
                  finish_reason?: string;
                  delta?: {
                    content?: string;
                    reasoning_content?: string;
                    tool_calls?: Array<{
                      index?: number;
                      id?: string;
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                }>
              | undefined;

            if (choices && choices.length > 0) {
              const choice = choices[0];
              if (choice.finish_reason) {
                if (choice.finish_reason === "tool_calls") output.stopReason = "toolUse";
                else if (choice.finish_reason === "length") output.stopReason = "length";
                else output.stopReason = "stop";
              }

              const delta = choice.delta;
              if (delta?.reasoning_content) {
                if (thinkingBlockIndex === -1) {
                  const block: ThinkingContent = {
                    type: "thinking",
                    thinking: delta.reasoning_content,
                  };
                  output.content.push(block);
                  thinkingBlockIndex = output.content.length - 1;
                  stream.push({
                    type: "thinking_start",
                    contentIndex: thinkingBlockIndex,
                    partial: output,
                  });
                } else {
                  const block = output.content[thinkingBlockIndex] as ThinkingContent;
                  block.thinking += delta.reasoning_content;
                  stream.push({
                    type: "thinking_delta",
                    contentIndex: thinkingBlockIndex,
                    delta: delta.reasoning_content,
                    partial: output,
                  });
                }
              }

              if (delta?.content) {
                if (thinkingBlockIndex !== -1) {
                  const block = output.content[thinkingBlockIndex] as ThinkingContent;
                  stream.push({
                    type: "thinking_end",
                    contentIndex: thinkingBlockIndex,
                    content: block.thinking,
                    partial: output,
                  });
                  thinkingBlockIndex = -1;
                }

                if (textBlockIndex === -1) {
                  const block: TextContent = { type: "text", text: delta.content };
                  output.content.push(block);
                  textBlockIndex = output.content.length - 1;
                  stream.push({
                    type: "text_start",
                    contentIndex: textBlockIndex,
                    partial: output,
                  });
                } else {
                  const block = output.content[textBlockIndex] as TextContent;
                  block.text += delta.content;
                  stream.push({
                    type: "text_delta",
                    contentIndex: textBlockIndex,
                    delta: delta.content,
                    partial: output,
                  });
                }
              }

              if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const callIdx = tc.index ?? 0;
                  if (!toolCallIndices.has(callIdx)) {
                    const block: ToolCall = {
                      type: "toolCall",
                      id: tc.id || `call_${Date.now()}_${callIdx}`,
                      name: tc.function?.name || "",
                      arguments: {},
                    };
                    output.content.push(block);
                    const contentIdx = output.content.length - 1;
                    toolCallIndices.set(callIdx, contentIdx);
                    toolCallRawArgs.set(callIdx, tc.function?.arguments || "");
                    stream.push({
                      type: "toolcall_start",
                      contentIndex: contentIdx,
                      partial: output,
                    });
                  } else {
                    const contentIdx = toolCallIndices.get(callIdx)!;
                    const block = output.content[contentIdx] as ToolCall;
                    if (tc.function?.name && !block.name) block.name = tc.function.name;
                    if (tc.function?.arguments) {
                      const prevArgs = toolCallRawArgs.get(callIdx) || "";
                      const newArgs = prevArgs + tc.function.arguments;
                      toolCallRawArgs.set(callIdx, newArgs);
                      try {
                        block.arguments = JSON.parse(newArgs);
                      } catch {
                        // incomplete JSON
                      }
                      stream.push({
                        type: "toolcall_delta",
                        contentIndex: contentIdx,
                        delta: tc.function.arguments,
                        partial: output,
                      });
                    }
                  }
                }
              }
            }

            // Usage update
            const chunkUsage = chunk.usage as
              | {
                  prompt_tokens?: number;
                  completion_tokens?: number;
                  prompt_tokens_details?: { cached_tokens?: number };
                }
              | undefined;

            if (chunkUsage) {
              const inTokens = chunkUsage.prompt_tokens || 0;
              const outTokens = chunkUsage.completion_tokens || 0;
              const cached = chunkUsage.prompt_tokens_details?.cached_tokens || 0;
              output.usage.input = inTokens;
              output.usage.output = outTokens;
              output.usage.cacheRead = cached;
              output.usage.totalTokens = inTokens + outTokens;
              calculateCost(model, output.usage);
            }
          }
        }
      }

      // A turn that produced no content at all is a failure, not an empty success.
      // Without this an error envelope carried on a 200, or a stream that never
      // produced a delta, ends as stopReason="stop" and renders as silence.
      // Skipped on abort, where empty output is the expected consequence.
      if (output.content.length === 0 && !options?.signal?.aborted) {
        const envelope = parseErrorEnvelope(capturedBody);
        throw new Error(
          envelope
            ? friendlyZCodeError(res.status, envelope)
            : `ZCode returned no content for ${model.id} (HTTP ${res.status}, no stream deltas). Retry, or run /zcode.doctor.`,
        );
      }

      // Close open blocks
      if (thinkingBlockIndex !== -1) {
        const block = output.content[thinkingBlockIndex] as ThinkingContent;
        stream.push({
          type: "thinking_end",
          contentIndex: thinkingBlockIndex,
          content: block.thinking,
          partial: output,
        });
      }
      if (textBlockIndex !== -1) {
        const block = output.content[textBlockIndex] as TextContent;
        stream.push({
          type: "text_end",
          contentIndex: textBlockIndex,
          content: block.text,
          partial: output,
        });
      }
      for (const [callIdx, contentIdx] of toolCallIndices.entries()) {
        const block = output.content[contentIdx] as ToolCall;
        const rawArgs = toolCallRawArgs.get(callIdx) || "{}";
        try {
          block.arguments = JSON.parse(rawArgs);
        } catch {
          block.arguments = {};
        }
        stream.push({
          type: "toolcall_end",
          contentIndex: contentIdx,
          toolCall: block,
          partial: output,
        });
      }

      setLastLatencyMs(Date.now() - startTime);
      setLastError(undefined);

      const doneReason =
        output.stopReason === "toolUse" ||
        output.stopReason === "length" ||
        output.stopReason === "deferred"
          ? output.stopReason
          : "stop";

      stream.push({ type: "done", reason: doneReason, message: output });
      stream.end();
    } catch (error) {
      setLastLatencyMs(Date.now() - startTime);
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      setLastError(output.errorMessage);

      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

function resolvePlanFromModel(model: Model<Api>): ZCodePlan {
  if (model.provider === "zcode-individual-plan" || model.provider === "zcode-individual") {
    return ZCodePlan.INDIVIDUAL_PLAN;
  }
  if (model.provider === "zcode-start-plan") {
    return ZCodePlan.START_PLAN;
  }
  // Aggregate base `zcode` provider: route by the plan that actually granted the model.
  const granted = baseProviderModelPlans.get(model.id);
  if (granted) {
    return granted;
  }
  // Unregistered id: with a single active plan there is no ambiguity.
  return activePlans.length === 1 ? activePlans[0] : ZCodePlan.START_PLAN;
}
