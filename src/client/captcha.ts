import { createServer, type Server } from "node:http";
import { exec } from "node:child_process";
import { buildZCodeSourceHeaders } from "./client.js";
import { zcodeFetch } from "../utils/http.js";
import { solveTraceless } from "./captcha-happy.js";

export interface CaptchaConfig {
  enabled: boolean;
  prefix: string;
  region: string;
  sceneId: string;
}

const DEFAULT_CAPTCHA_CONFIG: CaptchaConfig = {
  enabled: true,
  prefix: "no8xfe",
  region: "cn",
  sceneId: "11xygtvd",
};

let cachedConfig: CaptchaConfig | undefined = undefined;
let configExpiresAt = 0;

export async function fetchCaptchaConfig(token?: string): Promise<CaptchaConfig> {
  if (cachedConfig && Date.now() < configExpiresAt) {
    return cachedConfig;
  }

  try {
    const url = "https://zcode.z.ai/api/v1/client/configs";
    const headers = buildZCodeSourceHeaders();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await zcodeFetch(url, {
      method: "GET",
      headers,
      timeoutMs: 6000,
    });

    if (res.ok) {
      const data = (await res.json()) as {
        data?: {
          configs?: {
            captcha?: CaptchaConfig;
          };
        };
      };
      if (data.data?.configs?.captcha?.sceneId) {
        cachedConfig = data.data.configs.captcha;
        configExpiresAt = Date.now() + 60 * 60 * 1000;
        return cachedConfig;
      }
    }
  } catch {
    // fallback to defaults
  }

  return DEFAULT_CAPTCHA_CONFIG;
}

let activeParam: { param: string; obtainedAt: number; region: string } | undefined = undefined;
let solvePromise: Promise<{ param: string; region: string }> | null = null;

export function getStagedCaptchaParam(): { param: string; region: string } | undefined {
  if (activeParam && Date.now() - activeParam.obtainedAt < 90 * 1000) {
    const res = { param: activeParam.param, region: activeParam.region };
    activeParam = undefined; // single use
    return res;
  }
  return undefined;
}

export function stageCaptchaParam(param: string, region = "cn"): void {
  activeParam = { param: param.trim(), obtainedAt: Date.now(), region };
}

/**
 * Headless in-process CAPTCHA solver (primary path, zero browser popup).
 */
export async function solveCaptchaHeadless(
  token?: string,
  timeoutMs = 25000,
): Promise<{ captchaVerifyParam: string; captchaRegion: string }> {
  const config = await fetchCaptchaConfig(token);
  const param = await solveTraceless({
    scene: config.sceneId,
    region: config.region,
    prefix: config.prefix,
    timeoutMs,
    // Window reuse saves ~48% CPU per solve but keeps a pooled happy-dom
    // window (with live SDK timers/XHRs) parked for 120s after the last
    // solve — those handles pin the process, so `pi -p` and scripted runs
    // never exit. Reuse is opt-in (CAPTCHA_WINDOW_REUSE=1) for long-lived
    // interactive sessions; everything else destroys the DOM per solve.
    reuseWindow: process.env.CAPTCHA_WINDOW_REUSE === "1",
  });

  return {
    captchaVerifyParam: param,
    captchaRegion: config.region,
  };
}

/**
 * Get or automatically solve a CAPTCHA parameter headlessly in background.
 */
export async function getOrSolveCaptchaParam(
  token?: string,
): Promise<{ param: string; region: string }> {
  const staged = getStagedCaptchaParam();
  if (staged) {
    // Trigger non-blocking background solve for the next request
    warmCaptchaInBackground(token);
    return staged;
  }

  if (solvePromise) {
    return solvePromise;
  }

  solvePromise = (async () => {
    try {
      const solved = await solveCaptchaHeadless(token);
      // Trigger background prefill for next request
      setTimeout(() => warmCaptchaInBackground(token), 1000);
      return { param: solved.captchaVerifyParam, region: solved.captchaRegion };
    } finally {
      solvePromise = null;
    }
  })();

  return solvePromise;
}

/**
 * Silently warm a captcha token in background.
 */
export function warmCaptchaInBackground(token?: string): void {
  if (activeParam && Date.now() - activeParam.obtainedAt < 60 * 1000) return;
  if (solvePromise) return;

  solvePromise = (async () => {
    try {
      const res = await solveCaptchaHeadless(token, 15000);
      stageCaptchaParam(res.captchaVerifyParam, res.captchaRegion);
      return { param: res.captchaVerifyParam, region: res.captchaRegion };
    } catch {
      return { param: "", region: "cn" };
    } finally {
      solvePromise = null;
    }
  })();
}

function openBrowser(url: string): void {
  const start =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${start} "${url}"`, () => {});
}

/**
 * Acquire CAPTCHA verification param headlessly by default, or with browser loopback fallback.
 */
export async function acquireCaptchaVerifyParam(
  token?: string,
  timeoutMs = 30000,
  options?: { forceBrowser?: boolean },
): Promise<{ captchaVerifyParam: string; captchaRegion: string }> {
  if (!options?.forceBrowser) {
    try {
      return await solveCaptchaHeadless(token, timeoutMs);
    } catch {
      // If headless fails, fallback to loopback browser
    }
  }

  const config = await fetchCaptchaConfig(token);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId: NodeJS.Timeout | undefined = undefined;

    const cleanup = (server: Server) => {
      if (timeoutId) clearTimeout(timeoutId);
      if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      server.close();
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

      if (req.method === "GET" && url.pathname === "/captcha") {
        const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>ZCode Verification</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      background-color: #1a1b26;
      color: #c0caf5;
    }
    .card {
      background: #24283b;
      padding: 32px;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      text-align: center;
      max-width: 420px;
      width: 90%;
    }
    h2 { margin-top: 0; color: #7aa2f7; }
    p { color: #9aa5ce; font-size: 14px; line-height: 1.5; }
    #captcha-element { margin: 24px 0; min-height: 48px; }
    .status { margin-top: 16px; font-size: 13px; color: #bb9af7; }
  </style>
</head>
<body>
  <div class="card">
    <h2>ZCode Security Check</h2>
    <p>Please complete the verification below to continue using Start Plan.</p>
    <div id="captcha-element"></div>
    <button id="captcha-button" style="display:none"></button>
    <div id="status" class="status">Initializing...</div>
  </div>

  <script>
    const statusEl = document.getElementById("status");
    function setStatus(text, color) {
      statusEl.innerText = text;
      if (color) statusEl.style.color = color;
    }

    window.initAliyunCaptcha({
      SceneId: "${config.sceneId}",
      prefix: "${config.prefix}",
      mode: "popup",
      element: "#captcha-element",
      button: "#captcha-button",
      captchaVerifyCallback: async function(captchaVerifyParam) {
        setStatus("Verifying token...", "#e0af68");
        try {
          const res = await fetch("/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              captchaVerifyParam: captchaVerifyParam.captchaVerifyParam || captchaVerifyParam,
              region: "${config.region}"
            })
          });
          if (res.ok) {
            setStatus("Verification successful! You can close this tab.", "#9ece6a");
            setTimeout(() => window.close(), 1500);
            return { captchaResult: true };
          }
        } catch (e) {
          setStatus("Failed to submit verification: " + e.message, "#f7768e");
        }
        return { captchaResult: false };
      },
      onBizResultCallback: function(bizResult) {},
      getInstance: function(instance) {
        setStatus("Verification ready", "#7aa2f7");
        try {
          if (instance && typeof instance.startTracelessVerification === "function") {
            instance.startTracelessVerification();
          }
        } catch (e) {}
      }
    });
  </script>
</body>
</html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "POST" && url.pathname === "/submit") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body) as { captchaVerifyParam?: string; region?: string };
            if (parsed.captchaVerifyParam) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true }));
              settled = true;
              stageCaptchaParam(parsed.captchaVerifyParam, parsed.region || config.region);
              resolve({
                captchaVerifyParam: parsed.captchaVerifyParam,
                captchaRegion: parsed.region || config.region,
              });
              cleanup(server);
              return;
            }
          } catch {}
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_payload" }));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to start verification server"));
        return;
      }
      const verifyUrl = `http://127.0.0.1:${addr.port}/captcha`;
      openBrowser(verifyUrl);
    });

    timeoutId = setTimeout(() => {
      if (!settled) {
        cleanup(server);
        reject(new Error("Verification timed out after 60 seconds"));
      }
    }, timeoutMs);
  });
}
