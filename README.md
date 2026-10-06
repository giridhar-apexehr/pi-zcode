# pi-zcode

<p align="center">
  <a href="https://www.npmjs.com/package/pi-zcode"><img src="https://img.shields.io/npm/v/pi-zcode?logo=npm&logoColor=white&color=CB3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/pi-zcode"><img src="https://img.shields.io/npm/dm/pi-zcode?logo=npm&logoColor=white&color=CB3837" alt="npm downloads"></a>
  <a href="https://github.com/xifan2333/pi-zcode"><img src="https://img.shields.io/github/stars/xifan2333/pi-zcode?logo=github&logoColor=white&color=181717" alt="github stars"></a>
  <a href="https://github.com/xifan2333/pi-zcode/blob/master/LICENSE"><img src="https://img.shields.io/github/license/xifan2333/pi-zcode?logo=open-source-initiative&logoColor=white&color=blue" alt="license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20.0.0-339933?logo=node.js&logoColor=white" alt="node version">
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white" alt="typescript">
</p>

<p align="center">
  <b>Standalone ZCode / Z.AI / BigModel provider extension for Pi Coding Agent.</b>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

---

## Overview

`pi-zcode` is a lightweight, zero-dependency standalone provider extension that connects the [Pi Coding Agent](https://pi.dev) directly to ZCode, Z.AI, and BigModel cloud services. It brings GLM-5.3, GLM-5.3-Flash, and GLM-5.x reasoning models directly into your terminal coding workflow with zero external CLI or desktop application dependencies.

---

## Features

- **Pure Standalone**: Connects directly via upstream HTTP/SSE APIs. No local ZCode desktop client, CLI daemon, or proxy processes required.
- **Auto Plan Detection**: Automatically identifies account entitlements (`Start Plan` and `Individual Plan`) and dynamically registers providers (`zcode`, `zcode-start-plan`, `zcode-individual-plan`).
- **Dynamic Model Discovery**: Queries models live from upstream APIs instead of relying on hardcoded lists.
- **In-Process Headless CAPTCHA Solver**: Integrates an in-memory DOM simulation (`happy-dom`) solving Aliyun CAPTCHA challenges in under 1 second in the background. Completely automated with zero browser popups or workflow interruptions.
- **Full Reasoning & Tool Support**: Native streaming of thinking content (`reasoning_content` / Anthropic thinking blocks) and structured tool calls.
- **Quota & Diagnostics**: Real-time quota inspection via `/zcode.usage` and connection diagnostics via `/zcode.doctor`.

---

## Quick Start

1. **Install the extension in Pi**:

   ```bash
   pi install npm:pi-zcode
   ```

   Or install from local source:

   ```bash
   pi install /path/to/pi-zcode
   ```

2. **Authenticate with your ZCode account**:

   ```text
   /login zcode
   ```

   Select your preferred OAuth provider (`BigModel` for China mainland or `Z.ai` for Global).

3. **Select a model**:
   Use Pi's native model picker:
   ```text
   /model zcode/glm-5.3-flash
   ```
   or flagship reasoning model:
   ```text
   /model zcode/glm-5.3
   ```

---

## Commands

| Command         | Description                                                            |
| :-------------- | :--------------------------------------------------------------------- |
| `/login zcode`  | Log in via Z.ai or BigModel browser OAuth flow.                        |
| `/model`        | Pi native model selector showing all entitled ZCode models.            |
| `/zcode.usage`  | View detected plan tier, daily balance, and quota reset timestamps.    |
| `/zcode.doctor` | Show diagnostic stats (latency, request IDs, endpoint, error history). |

---

## Configuration & Environment Variables

| Variable             | Description                        | Default                             |
| :------------------- | :--------------------------------- | :---------------------------------- |
| `PI_ZCODE_DEVICE_ID` | Override persistent device MID     | Stored in `~/.pi/zcode/device.json` |
| `PI_ZCODE_BASE_URL`  | Override PaaS API endpoint         | Auto-resolved                       |
| `CAPTCHA_DEBUG`      | Enable verbose CAPTCHA solver logs | `false`                             |

---

## Development verification

`npm ci` installs the pinned Pi 1.0.2 development runtime; the integration test
runs this local CLI, not an installed Pi or installed copy of this extension.
Pi AI and Pi Coding Agent 1.0.2+ are required: the provider uses the public
transcript helpers to resolve current system prompts and tool declarations
(including tool changes/removals), while retaining legacy Context callers.
Use Node.js 24.18+ (the test runner uses native TypeScript transformation).
`npm test` is offline and uses mocked HTTP responses; it verifies serialization
and routing, **not** real tool execution.

For live lifecycle verification, first authenticate with `/login zcode` in Pi
and ensure the account can use both `glm-5.3` and `glm-5.3-flash`. Then run:

```bash
PI_ZCODE_LIVE=1 npm run test:integration
```

This uses real credentials and network requests and consumes account quota.
Without `PI_ZCODE_LIVE=1`, both tests explicitly skip. Credentials are read from
`$PI_CODING_AGENT_DIR/auth.json` (default `~/.pi/agent/auth.json`); optionally set
`PI_ZCODE_INTEGRATION_AUTH` to another existing auth file. Only its `zcode` entry
is copied into a private temporary agent directory. Other settings, extensions,
project instructions, sessions and endpoint overrides are excluded. Credentials
may refresh in the temporary copy but the original auth file is never modified.
Raw CLI output/diagnostics are not printed to avoid exposing secrets.

Each model gets a fresh isolated CLI run loading **this checkout's** extension,
a built-in `read` tool and a fixture with a cryptographically random token absent
from the prompt. A pass requires matching successful `tool_execution_start/end`
events, completed transcript messages in `toolCall -> toolResult -> final
assistant` order, and the exact token in the executed result and final assistant.
No history is injected and no provider is mocked. An exit code or a text-only
response alone cannot pass. Each CLI has a 180-second hard timeout and 8 MiB
output limit; temporary credentials, fixtures and caches are removed in `finally`.
A skipped run is **not live evidence**; a live pass proves this lifecycle only for
the tested runtime, account entitlement and models at that time, not every plan
or model. Provider/network/quota failures fail the test rather than skip it.

## License

[MIT](LICENSE)
