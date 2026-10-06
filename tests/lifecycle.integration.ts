import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const authPath =
  process.env.PI_ZCODE_INTEGRATION_AUTH ??
  join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"), "auth.json");
const live = process.env.PI_ZCODE_LIVE === "1";
const timeout = 180_000;

for (const model of ["glm-5.3", "glm-5.3-flash"]) {
  test(
    `live zcode/${model}: pi executes read and returns its fresh token`,
    {
      skip: !live && "Set PI_ZCODE_LIVE=1 to allow network requests and quota usage",
      timeout: timeout + 10_000,
    },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "pi-zcode-lifecycle-"));
      try {
        // Copy only the real zcode credential, never settings, models or other providers.
        // Do not log credential data or raw CLI diagnostics (even on failure).
        let credential: unknown;
        try {
          credential = JSON.parse(await readFile(authPath, "utf8")).zcode;
        } catch {
          assert.fail("Cannot read stored credentials; authenticate with /login zcode first");
        }
        assert.ok(credential, "Stored zcode credential is missing");
        const agentDir = join(directory, "agent");
        const cwd = join(directory, "workspace");
        await mkdir(agentDir, { mode: 0o700 });
        await mkdir(cwd);
        await writeFile(join(agentDir, "auth.json"), JSON.stringify({ zcode: credential }), {
          mode: 0o600,
        });
        await writeFile(
          join(agentDir, "settings.json"),
          JSON.stringify({
            retry: { enabled: false },
            compaction: { enabled: false },
          }),
        );
        const fixture = join(cwd, "fixture.txt");
        const token = randomBytes(32).toString("hex");
        await writeFile(fixture, `Verification token: ${token}\n`);

        // Whitelist environment: no installed extensions, provider endpoint overrides,
        // NODE_OPTIONS, project prompts or inherited pi session configuration.
        const env: NodeJS.ProcessEnv = {
          HOME: directory,
          USERPROFILE: directory,
          XDG_CACHE_HOME: join(directory, "cache"),
          PI_CODING_AGENT_DIR: agentDir,
        };
        for (const key of [
          "PATH",
          "SystemRoot",
          "HTTPS_PROXY",
          "HTTP_PROXY",
          "ALL_PROXY",
          "NO_PROXY",
          "https_proxy",
          "http_proxy",
          "all_proxy",
          "no_proxy",
          "SSL_CERT_FILE",
          "SSL_CERT_DIR",
          "NODE_EXTRA_CA_CERTS",
        ]) {
          if (process.env[key]) env[key] = process.env[key];
        }
        let stdout: string;
        const started = Date.now();
        try {
          const execution = run(
            process.execPath,
            [
              cli,
              "--mode",
              "json",
              "--no-session",
              "--no-extensions",
              "--extension",
              join(root, "src/index.ts"),
              "--no-skills",
              "--no-prompt-templates",
              "--no-themes",
              "--no-context-files",
              "--no-approve",
              "--tools",
              "read",
              "--provider",
              "zcode",
              "--model",
              model,
              "--thinking",
              "low",
              "--system-prompt",
              "Use the read tool when asked to inspect a file. Be concise.",
              `Use the read tool to read ${fixture}. Return the verification token from the file verbatim in your final answer. Do not guess the token.`,
            ],
            { cwd, env, timeout, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 },
          );
          // Pi reads non-TTY stdin before processing the supplied prompt.
          execution.child.stdin?.end();
          ({ stdout } = await execution);
        } catch (error) {
          const failure = error as { stderr?: string; code?: string | number; killed?: boolean };
          const diagnostics = failure.stderr ?? "";
          // Only print fixed classifications, never arbitrary CLI diagnostics/requests.
          const reasons = [
            [/unknown (option|argument)|unrecognized (option|argument)/i, "unsupported CLI option"],
            [/model.*not found|no model|unknown model/i, "requested model unavailable at startup"],
            [/cannot find (package|module)|ERR_MODULE_NOT_FOUND/i, "runtime module unavailable"],
            [/failed to load extension|extension.*error/i, "extension loading failed"],
            [/auth|credential|login/i, "authentication/startup credential failure"],
            [/fetch failed|ENOTFOUND|ECONN|network/i, "startup network failure"],
          ] as const;
          const reason = failure.killed
            ? "timeout/output limit"
            : (reasons.find(([pattern]) => pattern.test(diagnostics))?.[1] ??
              "unclassified CLI failure");
          const exit = typeof failure.code === "number" ? ` (exit ${failure.code})` : "";
          assert.fail(`Isolated pi CLI failed: ${reason}${exit}; raw diagnostics suppressed`);
        }
        let events: JsonAgentSessionEvent[];
        try {
          events = stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        } catch {
          assert.fail("Pi did not produce valid JSONL; raw output suppressed");
        }
        assert.ok(
          events.some((event) => event.type === "agent_settled"),
          "Run must settle",
        );
        const messages = events.flatMap((event) =>
          event.type === "message_end" ? [event.message] : [],
        );
        const failed = messages.find(
          (message) => message.role === "assistant" && message.stopReason === "error",
        );
        if (failed?.role === "assistant") {
          const error = failed.errorMessage ?? "";
          const categories = [
            [
              /no.*(API provider|stream function)|unknown api|not registered/i,
              "API provider registry unavailable",
            ],
            [/auth|credential|token expired|1004|1000/i, "authentication failure"],
            [/quota|balance|1113|1005|1210/i, "account quota/entitlement failure"],
            [/parameter|1214/i, "provider request schema rejected"],
            [/fetch failed|network|ECONN|ENOTFOUND/i, "provider network failure"],
          ] as const;
          const reason =
            categories.find(([pattern]) => pattern.test(error))?.[1] ??
            "unclassified provider error";
          assert.fail(`Final assistant failed: ${reason}; raw provider error suppressed`);
        }
        const callMessageIndex = messages.findIndex(
          (message) =>
            message.role === "assistant" &&
            message.content.some(
              (part) =>
                part.type === "toolCall" &&
                part.name === "read" &&
                typeof part.arguments.path === "string" &&
                resolve(cwd, part.arguments.path) === fixture,
            ),
        );
        assert.ok(callMessageIndex >= 0, "Model must emit a read toolCall for the fixture");
        const callMessage = messages[callMessageIndex];
        assert.ok(callMessage.role === "assistant");
        assert.equal(callMessage.provider, "zcode");
        assert.equal(callMessage.model, model);
        assert.equal(callMessage.stopReason, "toolUse");
        const call = callMessage.content.find(
          (part) =>
            part.type === "toolCall" &&
            part.name === "read" &&
            typeof part.arguments.path === "string" &&
            resolve(cwd, part.arguments.path) === fixture,
        );
        assert.ok(call?.type === "toolCall");
        const startIndex = events.findIndex(
          (event) =>
            event.type === "tool_execution_start" &&
            event.toolName === "read" &&
            event.toolCallId === call.id,
        );
        const endIndex = events.findIndex(
          (event) =>
            event.type === "tool_execution_end" &&
            event.toolName === "read" &&
            event.toolCallId === call.id,
        );
        assert.ok(
          startIndex >= 0 && endIndex > startIndex,
          "Matching execution start must precede end",
        );
        const end = events[endIndex];
        assert.ok(end.type === "tool_execution_end");
        assert.equal(end.isError, false, "Built-in read must succeed");
        assert.ok(
          end.result.content.some(
            (part: { type: string; text?: string }) =>
              part.type === "text" && part.text?.includes(token),
          ),
          "Executed read result must contain the fixture token",
        );
        const resultIndex = messages.findIndex(
          (message) => message.role === "toolResult" && message.toolCallId === call.id,
        );
        assert.ok(resultIndex > callMessageIndex, "Executed toolResult must follow model toolCall");
        const result = messages[resultIndex];
        assert.ok(result.role === "toolResult");
        assert.equal(result.isError, false);
        assert.ok(
          result.content.some((part) => part.type === "text" && part.text.includes(token)),
          "Transcript toolResult must contain the exact token",
        );
        const final = messages.at(-1);
        assert.ok(
          final?.role === "assistant" && messages.length - 1 > resultIndex,
          "Final assistant must follow the executed toolResult",
        );
        assert.equal(final.provider, "zcode");
        assert.equal(final.model, model);
        assert.equal(
          final.stopReason,
          "stop",
          "Final response must succeed, not error/abort/length",
        );
        assert.ok(
          final.content.some((part) => part.type === "text" && part.text.includes(token)),
          "Final assistant must contain the exact unpredictable token",
        );
        t.diagnostic(
          `pi 1.0.2 zcode/${model}: real read start/end success; toolCall -> toolResult -> final token verified (${Date.now() - started}ms)`,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
