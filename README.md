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
   npm install --omit-dev --legacy-peer-deps   # runtime deps (happy-dom, undici) are required
   pi install /path/to/pi-zcode
   ```

   > Local-source installs must run `npm install --omit-dev` first: without
   > `happy-dom`/`undici` the import chain throws and Pi silently skips the
   > whole extension (no provider, no models, no error). Do **not** install
   > `@earendil-works/*` locally — Pi aliases them to the host runtime, and a
   > local copy would create a second (version-skewed) instance.
   > `npm:pi-zcode` installs handle dependencies automatically.

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

## License

[MIT](LICENSE)
