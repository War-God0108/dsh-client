# DSH CLIENT — DeepSeek Harness 桌面客户端

独立的 DeepSeek Harness **桌面应用**（Electron 窗口 + 内置本地代理 + "深海探测舱"美学控制台）。不需要浏览器：双击启动脚本即弹出独立窗口，有自己的任务栏图标，与 DSH 实例通过本机回环 RPC 通信。

## 快速开始

**方式一：使用打包好的 exe（免 Node 环境）**

```
dist\DSH CLIENT-Setup-0.1.0.exe       安装器（推荐，装到开始菜单/桌面快捷方式）
dist\DSH CLIENT-Portable-0.1.0.exe    便携版（免安装，双击即用，适合放 U 盘）
```

**方式二：源码运行**

```bash
# 前置：DeepSeek Harness 正在运行（默认 http://127.0.0.1:3080）
npm start          # 启动桌面窗口
# 或者直接双击「启动桌面客户端.cmd」
```

首次运行会自动 `npm install`（Electron 二进制较大，约 1-2 分钟）。之后每次双击脚本直接打开窗口。

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_URL` | `http://127.0.0.1:3080` | DSH 实例地址 |

## 打包 exe（重新构建安装器）

```bash
npm run dist       # 或双击「打包exe.cmd」
# 产物：dist\DSH CLIENT-Setup-*.exe + DSH CLIENT-Portable-*.exe
```

打包配置在 `package.json` 的 `build` 字段：NSIS 安装器（可选择安装目录、创建桌面快捷方式）+ portable 单文件。应用本体**零运行时依赖**（内置 WS 服务器是手写的 RFC6455 实现），打包体积 ≈ 76MB。

## 架构

```
┌─────────────────────────────────────────────┐
│ Electron 窗口（DSH CLIENT 控制台 UI）        │
│    │  POST /api/<method>（保留 loopback Host │
│    │  WS  /api/events.mux / events.host     │
│    ▼                                        │
│ electron/main.js — 主进程                    │
│    └─ server.js — 内置代理（静态 + /api + WS）│
│         │ 转发（Host 原样保留 → 通过信任围栏） │
│         ▼                                   │
│ DeepSeek Harness (127.0.0.1:3080)           │
└─────────────────────────────────────────────┘
```

关键点：DSH 的 `/api` 信任围栏要求请求的 `Host` 是 loopback 权威且 `Origin` 与 `Host` 匹配。Node 的 `fetch` 禁止设置 `host` 头，因此代理用 `http.request` 原样转发浏览器的 Host/Origin —— 本地代理端口天然满足围栏条件，不需要 `trustedHosts` 配置。

`server.js` 以库形式被主进程复用：`createProxyServer({ dshUrl, port, publicDir })`。

## 功能

- **桌面窗口**：独立应用、单实例锁（重复启动聚焦已有窗口）、外链交给系统浏览器、深色主题窗口
- **会话管理**：列表（标题/时间/运行状态/cwd）、新建会话、自动打开最近会话
- **实时对话**：`events.mux` 流式渲染（思考 / 文本增量 / 工具调用卡片 / 轮次分隔 / 完成状态），乐观发送 + rpcId 去重
- **上下文可视化**：注入的系统上下文（AGENTS.md / 系统快照 / 技能目录）折叠为可展开的 CTX 卡片
- **遥测面板**：token 用量、上下文压力、todos、turns、当前模型
- **问题响应**：`question/requested` 渲染回答卡片，经 `/api/respond` 提交
- **连接管理**：双 WS 自动重连、状态灯（已连接/离线/忙）；DSH 不可达时弹窗提示

## RPC 契约速查（来自 dsh-host-apiproxy）

- 信封：`POST /api/<method>` body `{type:'client-request', rpcId, method, payload}` → `{type:'server-response', rpcId, result:{ok, value|error}}`
- 回答服务端问题：`POST /api/respond` body `{type:'client-response', rpcId, result:{ok:true, value}}`
- 下行流：`/api/events.mux`（session/event、session/projection、session/queue、session/jobs、question/requested）、`/api/events.host`（session-added/removed/status、agent-error）—— 纯下行 WebSocket

## 测试

测试自启动内嵌代理（与桌面应用相同的启动方式），无需预先运行任何服务器：

```bash
npm test                    # jsdom DOM 集成测试（真实页面 + 真实代理 + 真实 DSH）
node test-ws.mjs            # WS 下行代理冒烟
node test-e2e.mjs           # 全链路：建会话 → prompt → 观察实时事件流（需 DSH 运行）
node test-electron-runtime.mjs  # Electron Node 20 运行时（ELECTRON_RUN_AS_NODE）冒烟
```

Electron 运行时测试需用 Electron 自带的 Node 执行（验证打包环境的 WS polyfill 路径）：

```bash
set ELECTRON_RUN_AS_NODE=1 && node_modules\electron\dist\electron.exe test-electron-runtime.mjs
```

## 目录

```
dsh-client/
├── 启动桌面客户端.cmd    # 双击启动（Windows）
├── 打包exe.cmd           # 双击重新打包 exe
├── electron/
│   └── main.js          # Electron 主进程（内置代理 + 窗口）
├── server.js            # 本地代理（内嵌库，由主进程调用）
├── ws-server.js         # 零依赖 RFC6455 WebSocket 服务器（下行流桥接）
├── build/               # 应用图标（icon.ico 等）
├── dist/                # 打包产物（Setup / Portable）
├── public/
│   ├── index.html       # 控制台页面骨架
│   ├── style.css        # 深海探测舱主题
│   └── app.js           # 客户端逻辑（RPC 层 + 状态折叠 + 渲染）
└── test-*.mjs           # 测试脚本
```
