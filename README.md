# DSH CLIENT — DeepSeek Harness 桌面客户端

独立的 DeepSeek Harness **桌面应用**：Electron 窗口直接嵌入**官方网页界面**——与浏览器里完全相同的布局、全部功能，外加桌面壳层能力（任务栏图标、单实例锁、外链交给系统浏览器）。

不需要自己实现任何界面逻辑：功能与布局由 DSH 官方网页自身提供，官方更新时桌面端自动同步。

## 快速开始

**方式一：使用打包好的 exe（免 Node 环境）**

```
dist\DSH CLIENT-Setup-0.2.0.exe       安装器（推荐，装到开始菜单/桌面快捷方式）
dist\DSH CLIENT-Portable-0.2.0.exe    便携版（免安装，双击即用，适合放 U 盘）
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
| `DSH_URL` | `http://127.0.0.1:3080` | DSH 实例地址（窗口加载的官方界面来源） |

## 打包 exe（重新构建安装器）

```bash
npm run dist       # 或双击「打包exe.cmd」
# 产物：dist\DSH CLIENT-Setup-*.exe + DSH CLIENT-Portable-*.exe
```

打包配置在 `package.json` 的 `build` 字段：NSIS 安装器（可选择安装目录、创建桌面快捷方式）+ portable 单文件。

## 架构

```
┌─────────────────────────────────────────────┐
│ Electron 窗口（DSH CLIENT 桌面壳层）          │
│   ├─ 单实例锁（重复启动聚焦已有窗口）          │
│   ├─ 外链 → 系统浏览器（窗口内导航限制在同源）  │
│   └─ BrowserWindow ── loadURL(DSH_URL) ──┐  │
└──────────────────────────────────────────┼──┘
                                           ▼
                          DeepSeek Harness (127.0.0.1:3080)
                          └─ 官方网页界面（全部功能 + 布局，由 DSH 自身提供）
```

关键点：**零复制**。窗口加载的就是官方网页本身（同源，天然通过 `/api` 信任围栏），因此布局逐像素一致、功能完整，且官方 UI 更新后桌面端自动获得新功能。

## 功能

- **桌面壳层**：独立应用、任务栏图标、单实例锁（重复启动聚焦已有窗口）、外链交给系统浏览器、深色主题窗口
- **界面与功能**：与官方网页完全一致（会话管理、流式对话、工具调用、上下文、遥测、设置、主题等，全部由 DSH 网页界面提供）
- **连接管理**：官方网页自带连接状态横幅；DSH 不可达时窗口无法加载，弹出明确错误提示

## 历史实现（保留参考）

早期版本曾实现"本地代理 + 自定义控制台界面"（`server.js` / `ws-server.js` / `public/` 与 `test-*.mjs`），如今不再参与打包，仅保留在仓库中供协议验证与历史参考。可随时用 `git log` 找回旧版本。

## 测试

```bash
node test-electron-runtime.mjs  # 内嵌代理冒烟（旧代理栈，需 DSH 运行）
node test-ws.mjs                # WS 下行代理冒烟（旧代理栈）
node test-e2e.mjs               # 全链路（旧代理栈，需 DSH 运行，会创建临时会话）
node test-dom-jsdom.mjs         # DOM 集成（旧自定义界面）
```

当前桌面应用本身的验证方式是启动打包产物冒烟（见 README 变更历史）。

## 目录

```
dsh-client/
├── 启动桌面客户端.cmd    # 双击启动（Windows）
├── 打包exe.cmd           # 双击重新打包 exe
├── electron/
│   └── main.js          # Electron 主进程（窗口壳层，加载官方界面）
├── build/               # 应用图标（icon.ico 等）
├── dist/                # 打包产物（Setup / Portable）
├── server.js            # （历史）本地代理，不再参与打包
├── ws-server.js         # （历史）RFC6455 WS 服务器，不再参与打包
├── public/              # （历史）自定义控制台界面，不再参与打包
└── test-*.mjs           # （历史）测试脚本
```
