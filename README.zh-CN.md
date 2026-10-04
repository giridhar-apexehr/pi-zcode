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
  <b>面向 Pi Coding Agent 的纯原生 ZCode / Z.AI / 智谱 BigModel 扩展插件。</b>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a>
</p>

---

## 概述

`pi-zcode` 是为 [Pi Coding Agent](https://pi.dev) 打造的纯原生、高内聚 ZCode / Z.AI / 智谱 BigModel 扩展插件。支持在终端 Coding Agent 工作流中直接调用 GLM-5.3、GLM-5.3-Flash 及 GLM-5 系列大模型，无需依赖任何本地 ZCode 桌面应用或外部 CLI。

---

## 核心特性

- **纯独立运行（Zero Dependency）**：直连官方 HTTP/SSE 接口，不需要安装或运行本地 ZCode 桌面客户端或 CLI 守护进程，凭据安全保存在 Pi 原生 `~/.pi/agent/auth.json`。
- **自动计划探测与提供者注册**：自动识别账号所属的 `Start Plan`（每日免费额度）与 `Individual Plan`（专业订阅），并按需动态注册 Provider。
- **动态模型发现**：启动及登录后自动从云端接口拉取当前账号实际可用的模型列表，无需手动维护静态配置。
- **纯内存 Headless 静默验证码求解**：内置基于 `happy-dom` 的内存级阿里云验证码求解器，后台毫秒级（约 700ms）自动完成无感验证与 Token 预热，大段自动化 Agent 编码任务 100% 不被打断。
- **原生思考链与工具调用**：完整支持 GLM 系列模型的深度思考链（`thinking_delta` / `reasoning_content`）流式输出以及结构化工具调用（Tool Calling）。
- **配额与健康诊断**：内置 `/zcode.usage`（查看计划与每日余额）和 `/zcode.doctor`（查看网络延迟与诊断信息）。

---

## 快速开始

1. **在 Pi 中安装插件**：

   ```bash
   pi install npm:pi-zcode
   ```

   或从本地源码安装：

   ```bash
   npm install --omit-dev --legacy-peer-deps   # 必须先装运行依赖（happy-dom、undici）
   pi install /path/to/pi-zcode
   ```

   > 从本地源码安装前必须先执行 `npm install --omit-dev`：缺少
   > `happy-dom`/`undici` 时 import 链会抛错，而 Pi 会静默跳过整个扩展
   > （没有 provider、没有模型、也没有任何报错）。**不要**在本地安装
   > `@earendil-works/*`——Pi 会把它们别名到宿主运行时，本地副本会产生
   > 版本错位的第二实例。`npm:pi-zcode` 安装方式会自动处理依赖。

2. **登录账号**：

   ```text
   /login zcode
   ```

   在弹出的选择框中选择 `BigModel (China)` 或 `Z.ai (Global)` 完成网页 OAuth 授权。

3. **选择并使用模型**：
   使用 Pi 原生的 `/model` 选择器：
   ```text
   /model zcode/glm-5.3-flash
   ```
   或体验旗舰大模型：
   ```text
   /model zcode/glm-5.3
   ```

---

## 快捷指令

| 命令            | 说明                                                        |
| :-------------- | :---------------------------------------------------------- |
| `/login zcode`  | 发起 Z.ai / BigModel 官方网页 OAuth 登录流程。              |
| `/model`        | Pi 原生模型选择器，展示当前账号所有可用模型。               |
| `/zcode.usage`  | 查询当前计划状态、每日模型余量与重置时间。                  |
| `/zcode.doctor` | 显示连接诊断（Endpoint、请求延迟、Request ID 与报错日志）。 |

---

## 环境变量

| 环境变量             | 说明                     | 默认值                                 |
| :------------------- | :----------------------- | :------------------------------------- |
| `PI_ZCODE_DEVICE_ID` | 自定义设备指纹 MID       | 自动持久化于 `~/.pi/zcode/device.json` |
| `PI_ZCODE_BASE_URL`  | 自定义 PaaS 接口地址     | 自动按账号解析                         |
| `CAPTCHA_DEBUG`      | 开启验证码求解器详细日志 | `false`                                |

---

## 开源协议

[MIT](LICENSE)
