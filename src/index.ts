import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import { getZCodeApiKey, loginZCode, refreshZCodeToken } from "./auth/index.js";
import { readStoredZCodeCredentials } from "./auth/credentials.js";
import {
  acquireCaptchaVerifyParam,
  DEFAULT_ENDPOINT,
  endpointCandidates,
  prewarmConnection,
} from "./client/index.js";
import { getLastDiagnostics, runWithDiagnostics } from "./diagnostics/index.js";
import {
  buildModelsForPlan,
  fetchModelCatalog,
  fetchModelIdsForPlan,
  PROVIDER_ID,
  providerIdForPlan,
  PROVIDER_NAMES,
} from "./models/index.js";
import { detectAccountPlans } from "./plans/index.js";
import {
  ZCODE_API,
  clearBaseProviderModelPlans,
  registerBaseProviderModelPlans,
  setActivePlans,
  streamZCode,
} from "./stream/index.js";
import { ZCodePlan, ZCodePlanStatus } from "./types/enums.js";
import type { ZCodeAccountPlans, ZCodeParsedApiKey } from "./types/types.js";
import { fetchAccountUsage, formatUsageReport, resolveApiKeyFromContext } from "./usage/index.js";
import { redactSecrets } from "./utils/index.js";

function emitCommandOutput(
  ctx: ExtensionCommandContext,
  text: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
    return;
  }
  if (type === "warning" || type === "error") {
    console.error(text);
  } else {
    console.log(text);
  }
}

let activeExtensionAPI: ExtensionAPI | undefined = undefined;

export async function detectAndRegisterPlans(
  pi: ExtensionAPI,
  credentials: ZCodeParsedApiKey,
): Promise<ZCodeAccountPlans> {
  const credsPayload = credentials
    ? JSON.stringify({
        access: credentials.token,
        businessAccessToken: credentials.businessAccessToken,
        zcodeJwtToken: credentials.zcodeJwtToken,
        providerSource: credentials.providerSource,
      })
    : "";

  const plans = await runWithDiagnostics(() => detectAccountPlans(credsPayload));
  const catalog = await fetchModelCatalog(credentials.zcodeJwtToken);

  // Re-detected on every login/session start, so drop stale routing first.
  clearBaseProviderModelPlans();

  const registrations: { plan: ZCodePlan; ids: string[] | undefined }[] = [];

  if (plans.startPlan.status === ZCodePlanStatus.ACTIVE) {
    registrations.push({ plan: ZCodePlan.START_PLAN, ids: plans.startPlan.models });
  }
  if (plans.individualPlan.status === ZCodePlanStatus.ACTIVE) {
    registrations.push({ plan: ZCodePlan.INDIVIDUAL_PLAN, ids: undefined });
  }

  setActivePlans(registrations.map((reg) => reg.plan));

  const allActiveModels = [];

  for (const reg of registrations) {
    const ids = await fetchModelIdsForPlan(
      reg.plan,
      credentials
        ? JSON.stringify({
            access: credentials.token,
            providerSource: credentials.providerSource,
          })
        : undefined,
      reg.ids,
    );

    if (!ids.length) {
      continue;
    }

    const models = buildModelsForPlan(ids, catalog);
    const providerId = providerIdForPlan(reg.plan);

    // The base `zcode` provider aggregates every active plan's models, so record
    // which plan granted each id. Without it the stream routes base-provider models to
    // the Start Plan proxy by default, which fails silently for Individual Plan accounts.
    registerBaseProviderModelPlans(ids, reg.plan);

    // Register dedicated provider for this plan (e.g. zcode-start-plan)
    pi.registerProvider(providerId, {
      name: PROVIDER_NAMES[reg.plan],
      baseUrl: DEFAULT_ENDPOINT,
      api: ZCODE_API,
      models,
      streamSimple: streamZCode,
    });

    allActiveModels.push(...models);
  }

  // Also register active models on the base `zcode` provider so /model zcode/<model> works
  pi.registerProvider(PROVIDER_ID, {
    name: "ZCode",
    baseUrl: DEFAULT_ENDPOINT,
    api: ZCODE_API,
    models: allActiveModels,
    oauth: {
      name: "ZCode",
      login: async (callbacks) => {
        const creds = await loginZCode(callbacks);
        if (activeExtensionAPI) {
          const parsed = readStoredZCodeCredentials(true);
          if (parsed) {
            await detectAndRegisterPlans(activeExtensionAPI, parsed).catch(() => undefined);
          }
        }
        return creds;
      },
      refreshToken: refreshZCodeToken,
      getApiKey: getZCodeApiKey,
    },
    streamSimple: streamZCode,
  });

  return plans;
}

export default async function initZCodeExtension(pi: ExtensionAPI): Promise<void> {
  activeExtensionAPI = pi;

  const [primaryEndpoint] = endpointCandidates();
  if (primaryEndpoint) {
    prewarmConnection(primaryEndpoint);
  }

  registerApiProvider({
    api: ZCODE_API,
    stream: streamZCode,
    streamSimple: streamZCode,
  });

  // Base provider registration
  pi.registerProvider(PROVIDER_ID, {
    name: "ZCode",
    baseUrl: DEFAULT_ENDPOINT,
    api: ZCODE_API,
    models: [],
    oauth: {
      name: "ZCode",
      login: async (callbacks) => {
        const creds = await loginZCode(callbacks);
        const parsed = readStoredZCodeCredentials(true);
        if (parsed) {
          await detectAndRegisterPlans(pi, parsed).catch(() => undefined);
        }
        return creds;
      },
      refreshToken: refreshZCodeToken,
      getApiKey: getZCodeApiKey,
    },
    streamSimple: streamZCode,
  });

  // If already logged in, register plan providers immediately on startup
  const stored = readStoredZCodeCredentials(true);
  if (stored) {
    await detectAndRegisterPlans(pi, stored).catch(() => undefined);
  }

  // Refresh plan registration on session start
  pi.on("session_start", async () => {
    const creds = readStoredZCodeCredentials(true);
    if (creds) {
      await detectAndRegisterPlans(pi, creds).catch(() => undefined);
    }
  });

  pi.registerCommand("zcode.usage", {
    description: "Show detected plans, daily balance, and subscription status",
    handler: async (_args, ctx) => {
      try {
        const apiKey = await resolveApiKeyFromContext(ctx);
        if (!apiKey) {
          emitCommandOutput(ctx, "No ZCode credentials found. Run /login zcode first.", "warning");
          return;
        }
        if (ctx.hasUI) {
          ctx.ui.notify("Fetching ZCode usage…", "info");
        }
        const creds = readStoredZCodeCredentials(true);
        const plans = creds
          ? await detectAccountPlans(
              JSON.stringify({
                access: creds.token,
                businessAccessToken: creds.businessAccessToken,
                zcodeJwtToken: creds.zcodeJwtToken,
                providerSource: creds.providerSource,
              }),
            )
          : await detectAccountPlans(apiKey);
        const usage = await fetchAccountUsage(apiKey, plans);
        emitCommandOutput(ctx, formatUsageReport(plans, usage));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `Failed to fetch ZCode usage: ${msg}`, "warning");
      }
    },
  });

  pi.registerCommand("zcode.doctor", {
    description: "Show ZCode diagnostics report",
    handler: async (_args, ctx) => {
      const d = getLastDiagnostics();
      const lines = [
        "ZCode Provider Doctor",
        `• providerId: ${PROVIDER_ID}`,
        `• endpoint: ${d.endpoint || "none"}`,
        `• status: ${d.status ?? "none"}`,
        `• model: ${d.resolvedRuntimeModel || "none"}`,
        `• latencyMs: ${d.latencyMs !== undefined ? `${d.latencyMs}ms` : "none"}`,
        `• requestId: ${d.requestId || "none"}`,
        `• error: ${d.error ? redactSecrets(d.error) : "none"}`,
        "• transport: native-streamSimple (SSE)",
        "• commands: /login zcode, /zcode.usage, /zcode.doctor",
      ];
      emitCommandOutput(ctx, lines.join("\n"));
    },
  });

  const OVERFLOW_PATTERN = /context_length_exceeded|maximum context length/i;
  pi.on("message_end", (event, _ctx) => {
    const { message } = event;
    if (message.role !== "assistant") {
      return;
    }
    if (message.stopReason !== "error") {
      return;
    }
    if (
      message.provider !== "zcode-start-plan" &&
      message.provider !== "zcode-individual-plan" &&
      message.provider !== PROVIDER_ID
    ) {
      return;
    }
    const errorMessage = message.errorMessage ?? "";
    if (errorMessage.includes("context_length_exceeded")) {
      return;
    }
    if (!OVERFLOW_PATTERN.test(errorMessage)) {
      return;
    }
    return {
      message: { ...message, errorMessage: `context_length_exceeded: ${errorMessage}` },
    };
  });
}
