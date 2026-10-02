# Deepseek Harness — 桌面客户端

独立的 DeepSeek Harness **桌面应用**：Electron 窗口直接嵌入**官方网页界面**——与浏览器里完全相同的布局、全部功能，外加桌面壳层能力（任务栏图标、单实例锁、外链交给系统浏览器）。

**双击即用**：如果本地 DSH 服务没有运行，应用会自动拉起（`npx -y @deepseek-ai/dsh web`，隐藏控制台），等它就绪后打开界面；关闭应用时会把拉起的服务一并结束。

不需要自己实现任何界面逻辑：功能与布局由 DSH 官方网页自身提供，官方更新时桌面端自动同步。

## 快速开始

**方式一：使用打包好的 exe（免 Node 环境）**

```
dist\Deepseek Harness-Setup-0.5.1.exe       安装器（推荐，装到开始菜单/桌面快捷方式）
dist\Deepseek Harness-Portable-0.5.1.exe    便携版（免安装，双击即用，适合放 U 盘）
```

> 需要本机已安装 Node.js 且能访问网络（首次自动拉起 DSH 时要下载 dsh 包，之后走缓存秒开）。如果 DSH 已在运行（比如你自己开的 `npx @deepseek-ai/dsh web`），桌面端直接复用，不会重复启动。
>
> **0.4.8+（适配 DSH 0.1.2+ 访问令牌）**：DSH 0.1.2 起网页版带每进程随机令牌（URL `?token=…`），直接打开裸地址会看到 "dsh web authentication required"。桌面端会自动处理：应用自己拉起的宿主从 `dsh-host.log` 读取令牌完成一次登录换取 30 天 Cookie；由其他程序启动的宿主且无有效 Cookie 时会提示先关闭该程序再重开本应用。
>
> **0.5.0（不再弹出浏览器）**：`dsh web` 默认启动后会把界面交给系统默认浏览器（`openBrowser: true`），桌面端会因此多弹一个浏览器窗口。现在应用拉起宿主时固定加 `--no-open`，界面只出现在桌面窗口里；令牌仍然照常打印到 `dsh-host.log`，登录流程不受影响。想恢复"顺带打开浏览器"的旧行为，设 `DSH_OPEN_BROWSER=1` 即可。注意：自己手动跑 `npx @deepseek-ai/dsh web` 时仍会打开浏览器，那是 DSH 自身的行为，需要 `--no-open` 或在本机配置文件里关掉。
>
> **0.5.1（黑屏根治：加载骨架屏 + 失败可诊断）**：之前的"黑屏"来自一段真空期——DSH 的 shell 页面 `did-finish-load` 很早（不到 1 秒），而客户端 bundle 把它挂载成真正的界面还要几秒；这几秒里窗口只有自己的深色背景，看起来就是卡死/黑屏，日志却写着 "official UI loaded"。现在：
>
> - 真实界面挂载前，页面会被一层「界面加载中…」骨架屏盖住，挂载完成（DOM 节点数超过阈值）后自动淡出，日志记录 `UI mounted after ~Xs`；
> - 界面挂载后会把窗口重新提到最前（此前窗口可能一直压在浏览器后面，只露出深色背景）；
> - 加载失败（`did-fail-load`）、渲染进程崩溃（`render-process-gone`）、渲染器 console 报错都会逐条写进 `app.log`；
> - 骨架屏超过 45 秒没等到挂载、或过渡页超过 15 秒（且不是在等宿主启动）会显示**恢复页**：写明失败原因、两个日志路径，并提供「重试」和「打开日志目录」；若 3080 被别的程序占着且它要求访问令牌，重试会自动结束那个宿主、由应用自己重新拉起一个。

**方式二：源码运行**

```bash
npm start          # 启动桌面窗口（DSH 未运行时会自动拉起）
# 或者直接双击「启动桌面客户端.cmd」
```

首次运行会自动 `npm install`（Electron 二进制较大，约 1-2 分钟）。之后每次双击脚本直接打开窗口。

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_URL` | `http://127.0.0.1:3080` | DSH 实例地址（窗口加载的官方界面来源；自动拉起的服务也会用这个端口） |
| `DSH_HOME` | `~/.dsh` | 传给自动拉起的 DSH 服务的数据目录（默认使用与网页版相同的数据） |
| `DSH_OPEN_BROWSER` | 关（即加 `--no-open`） | 设为 `1` / `true` 时，自动拉起的宿主仍会把界面交给系统默认浏览器（旧行为，会多弹一个浏览器窗口） |
| `DSH_CLIENT_DEBUG` | 无 | 设为文件路径可输出启动过程调试日志（排查问题用） |

## 打包 exe（重新构建安装器）

```bash
npm run dist       # 或双击「打包exe.cmd」
# 产物：dist\Deepseek Harness-Setup-*.exe + Deepseek Harness-Portable-*.exe
```

打包配置在 `package.json` 的 `build` 字段：NSIS 安装器（可选择安装目录、创建桌面快捷方式）+ portable 单文件。

## 架构

```
┌─────────────────────────────────────────────┐
│ Electron 窗口（Deepseek Harness 桌面壳层）    │
│   ├─ 单实例锁（重复启动聚焦已有窗口）          │
│   ├─ 外链 → 系统浏览器（窗口内导航限制在同源）  │
│   ├─ 自动拉起 DSH 服务（若 3080 未运行）       │
│   │    └─ npx -y @deepseek-ai/dsh web ──┐    │
│   └─ BrowserWindow ── loadURL(DSH_URL) ─┼──┐ │
└──────────────────────────────────────────┼──┼─┘
                                           ▼  ▼
                          DeepSeek Harness (127.0.0.1:3080)
                          └─ 官方网页界面（全部功能 + 布局，由 DSH 自身提供）
```

关键点：**零复制**。窗口加载的就是官方网页本身（同源，天然通过 `/api` 信任围栏），因此布局逐像素一致、功能完整，且官方 UI 更新后桌面端自动获得新功能。应用自己拉起的 DSH 服务在应用退出时自动结束；检测到已有实例则直接复用。

## 功能

- **桌面壳层**：独立应用、任务栏图标、单实例锁（重复启动聚焦已有窗口）、外链交给系统浏览器、深色主题窗口
- **自动拉起 DSH**：检测到本地 DSH 未运行就自动启动（隐藏控制台，启动中显示过渡页），关闭应用时自动结束拉起的服务；已有实例则直接复用
- **自动适配访问令牌（DSH 0.1.2+）**：自动解析自己拉起的宿主打印的 `?token=` URL 完成登录（换取 30 天 Cookie，之后直开裸地址即可）；外部宿主无 Cookie 时给出中文引导
- **界面与功能**：与官方网页完全一致（会话管理、流式对话、工具调用、上下文、遥测、设置、主题等，全部由 DSH 网页界面提供）
- **会话删除（插件，不靠补丁）**：启动时把 `dsh-session-delete` 宿主插件部署进 `$DSH_HOME/profiles`（`electron/install-plugin.mjs` + `electron/plugin/dsh-session-delete/`），删除逻辑全部在插件里、经它自己的 `/api/dsd` 路由暴露给浏览器，DSH 升级不会带走它

## 「删除会话」插件说明

DSH 官方网页尚未提供「删除会话」入口，本仓库用一个**普通用户插件**补上（`electron/plugin/dsh-session-delete/`，双半端）：

- **浏览器半端**（`lib/client.js`）：往官方扩展槽位 `sidebar.workspaces.session.menu.item` 注册「删除会话」菜单项（危险样式，排在官方「归档会话」之后），并在 `shell.overlay` 注册确认弹窗（中英双语文案，失败时把宿主的错误码翻译成可操作提示）；
- **宿主半端**（`lib/index.js`）：在 `/api/dsd` 暴露 `probe` / `delete` 两个端点——删除时先 `flush`、再停掉活动 Agent、从各工作区解绑、删除持久化日志（`session.jsonl[.zstd]` 与会话目录），最后广播 `api-session/removed` 让所有浏览器立刻移除该行；由子代理拥有的会话会被拒绝；
- **活动会话的拆除**：优先调用官方 `sessionController.agents.disposeAgent(sessionId)`（DSH 0.2 的 `ApiSessionAgentController.disposeAgent` 就是官方 API——控制器保留的 `AgentHandle` 是官方认可的拆除路径；0.1.x 时代同一位置由补丁提供，两种形状都会尝试）；拿不到该 API 时，用公开注册表原语复刻官方 agent-loop 的 dispose 顺序兜底（`cancel({kind:"disposed"})` → `whenIdle()` → `scope.dispose()` → `agents.detachEntered` → `sessions.detachEntered`）；`disposeAgent` 返回 `false`（句柄不属于本进程）时报 `agent-busy` 而不是误删；
- **部署方式**：桌面应用每次启动（拉起宿主前）调用 `install-plugin.mjs`，把**应用包内**的 `electron/plugin/dsh-session-delete` 复制进 `%USERPROFILE%\.dsh\profiles\node_modules\dsh-session-delete`（先删后拷，覆盖旧副本），并在 `cordis.patch.yml` 挂载 `- id: session-delete`（已挂载则跳过）。⚠️ 因此**改了插件必须重新打包/安装桌面端**，否则每次启动都会被应用包里的旧副本覆盖；或者直接双击 `启动桌面客户端.cmd` 以源码方式运行（它部署的就是当前源码里的插件）。另外，新增客户端半端需要**重启一次 DSH** 才会进入客户端模块表，之后改动走 client-hmr；
- 直接命令行 `npx @deepseek-ai/dsh web` 时，可手动执行 `node electron/install-plugin.mjs` 后重启 DSH；
- **探测与调用**：`POST /api/dsd` + `{"endpoint":"probe"}` → `{disposedHook, disposeOnAgents, disposeOnService, nativeTeardown, canStopLive, located, controllerKeys}`（`controllerKeys` 是升级后排查用的诊断字段）；删除：`{"endpoint":"delete","payload":{"sessionId":"…"}}`；
- **自检**：重启后运行 `powershell -ExecutionPolicy Bypass -File verify-session-delete.ps1`（检查客户端半端是否进入启动清单、bundle 是否含菜单项与 `/api/dsd`、宿主能力探测），再按脚本末尾的肉眼清单点一次菜单；
- 0.1.x 时代的 npx 缓存补丁机制已停用并移入 `legacy/`（0.2 不再支持手改生成式 typert 端点表），仅为历史参考，见 `legacy/README.md`。

## 历史实现（保留参考）

早期版本曾实现"本地代理 + 自定义控制台界面"（`server.js` / `ws-server.js` / `public/` 与 `test-*.mjs`），如今不再参与打包，仅保留在仓库中供协议验证与历史参考。可随时用 `git log` 找回旧版本。

## 测试

```bash
node test-session-delete-host.mjs    # 「删除会话」宿主半端：拆除顺序、解绑、文件清理、围栏（无需 DSH）
node test-session-delete-client.mjs  # 「删除会话」浏览器半端：槽位注册、菜单项、确认弹窗、/api/dsd（无需 DSH）
node test-electron-runtime.mjs  # 内嵌代理冒烟（旧代理栈，需 DSH 运行）
node test-ws.mjs                # WS 下行代理冒烟（旧代理栈）
node test-e2e.mjs               # 全链路（旧代理栈，需 DSH 运行，会创建临时会话）
node test-dom-jsdom.mjs         # DOM 集成（旧自定义界面）
python smoke-spawn-test.py      # 桌面端冒烟：验证"自己拉起宿主 -> 窗口正常渲染"这条路径
```

`test-session-delete-host.mjs` 用假的服务注册表驱动真实的 `deleteSession` / `probe`，断言拆除顺序与官方 `agent-loop` 的 dispose 一致（`cancel({kind:"disposed"})` → `whenIdle` → `scope.dispose` → `detach agent` → `detach session`）、工作区解绑、产物文件与目录被删除、冷会话可删、未知会话返回 `not-found`、子代理会话被拒（`agent-busy`）；`test-session-delete-client.mjs` 捕获 `__ModuleLoader__.load` 后用 React 桩件跑真实 bundle，断言槽位注册（含 `order: 500`）、菜单项文案与危险样式、确认弹窗的「取消/删除」两条路径、`/api/dsd` 请求体与错误码翻译。两者都不需要 DSH 在跑，也不依赖磁盘上的 react。

`smoke-spawn-test.py` 会用 `DSH_URL=http://127.0.0.1:3099` 启动打包产物，确认它确实拉起了宿主、界面挂载完成（日志出现 `UI mounted after ~Xs`）、窗口渲染出真实界面（按窗口区域抓屏做像素采样，不是只看日志）、没有触发看门狗或恢复页，并在结束时把拉起的进程全部清掉。运行前需先关闭已打开的桌面端（单实例锁）。

## 目录

```
dsh-client/
├── 启动桌面客户端.cmd    # 双击启动（Windows）
├── 打包exe.cmd           # 双击重新打包 exe
├── electron/
│   ├── main.js                        # Electron 主进程（窗口壳层，加载官方界面）
│   ├── install-plugin.mjs             # 部署「删除会话」宿主插件（幂等）
│   └── plugin/dsh-session-delete/     # 「删除会话」宿主插件（/api/dsd）
├── build/               # 应用图标（icon.ico / whale.svg 等）
├── dist/                # 打包产物（Setup / Portable）
├── legacy/              # 停用的 npx 缓存补丁机制（0.1.x 时代，见 legacy/README.md）
├── server.js            # （历史）本地代理，不再参与打包
├── ws-server.js         # （历史）RFC6455 WS 服务器，不再参与打包
├── public/              # （历史）自定义控制台界面，不再参与打包
└── test-*.mjs           # （历史）测试脚本
```
