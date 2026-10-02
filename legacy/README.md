# legacy/ — 停用的「npx 缓存补丁」机制（DSH 0.1.x 时代）

这里的文件是桌面端早期为「删除会话」功能准备的**补丁机制**，自 DSH 0.2 起**不再被使用**，保留仅为历史参考与考古。

## 内容

| 文件 | 作用 |
|---|---|
| `patch-delete-session.mjs` | 补丁应用器：扫描 `%LOCALAPPDATA%\npm-cache\_npx\*\node_modules`，按 `@deepseek-ai/dsh` 的版本前缀选择补丁集，逐条做"锚点必须精确命中一次"的文本替换（支持行首空白模糊回退；不匹配时报 `MISMATCH` 而不是写坏文件） |
| `delete-session-patch.json` | 补丁集 v2：`0.1.2` 集（宿主 `session/remove` RPC、typert remote/host 契约、浏览器 `Session.remove`、工作区侧边栏菜单与确认弹窗，26 条）与 `0.1.0-rc.6` 集（旧目标） |
| `.patch-work/gen-patch.mjs` | 生成器：`npm pack @deepseek-ai/dsh-*@<版本>` 取原版文件，对 `orig/` 与 live 文件做 `git diff --no-index`，按 feature markers 抽出 hunk 并交叉验证，产出新的补丁 JSON |

## 为什么停用

- **0.1.x**：官方没有「删除会话」入口，且当时的 RPC 层（`dsh-host-apiproxy` 之类）可以用文本补丁加端点，所以走"补丁补上菜单项和活动 Agent 拆除钩子 + 插件承载删除逻辑"的组合。
- **0.2.x**：DSH 把远程端点改成**生成式 typert 表**（`typert.remote-client.js` / `typert.host.js` 文件头即写 *Generated … do not edit*），手工往表里加端点不会被客户端挂载识别；同时官方补齐了扩展点槽位 **`sidebar.workspaces.session.menu.item`**（会话三点菜单项），因此正确做法是**写一个客户端半端插件注册菜单项**，配合已有的宿主插件 `/api/dsd` 路由——完全不需要补丁。
- 结论：`main.js` 不再调用本目录任何代码；`dsh-session-delete` 插件（`electron/plugin/dsh-session-delete/`）成为唯一实现。

## 若将来仍需要旧版补丁

1. 取原版：`npm pack @deepseek-ai/dsh-api-session-controller@<版本>`（以及 `dsh-client-ui-workspace`），解包到 `.patch-work/orig/`；
2. 手工把改动应用到 live 文件，`node .patch-work/gen-patch.mjs` 生成新 JSON（脚本会交叉验证 keep/exclude 的 hunk）；
3. 用 `node patch-delete-session.mjs <npx根>` 单独试跑，确认 `0 failed` 后再接回启动流程。

> 提醒：任何针对 npx 缓存的写入都会被 `npx`/npm 重装或缓存清理冲掉；这也是当年把它做成"每次启动重放"的原因。0.2 之后推荐一律走插件。
