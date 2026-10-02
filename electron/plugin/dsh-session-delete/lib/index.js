// dsh-session-delete — Host 半端（DSH 0.1.5+ 与 0.2.x）
//
// 为浏览器端提供「删除会话」接口（HTTP 通道 /api/dsd）：
//   probe  探测当前宿主是否具备完整删除能力（活动 Agent 拆除钩子是否已打补丁）
//   delete 永久删除一个会话：停止其活动 Agent、解绑工作区、删除持久化日志
//
// 通道用 connection.fetch.register 注册在 /api 下（与官方插件 file-upload /
// api-session-controller、以及本机 dsh-archive-manager 相同的做法）：/api 前缀
// 路由本身已完成 Host/Origin 校验与浏览器会话鉴权，这里不需要再做鉴权。
//
// 为什么删除逻辑放在插件里而不是补丁里：
//   DSH 0.1.x 时代只有两处必须改动 DSH 自身包文件——(1) 侧边栏会话三点菜单项、
//   (2) 活动 Agent 的拆除句柄（AgentHandle 只发给创建者，官方无公开 API）。
//   0.2 起这两处都不再需要补丁：
//   (1) 官方提供了扩展槽位 `sidebar.workspaces.session.menu.item`，本插件自带的
//       浏览器半端（lib/client.js）在其中注册「删除会话」菜单项与确认弹窗；
//   (2) 活动会话的拆除改用公开注册表原语复刻官方 agent-loop 的 dispose 顺序
//       （cancel → whenIdle → scope.dispose → detach agent → detach session）。
//   其余全部逻辑（定位产物、删除、解绑、广播）本来就在本插件中：DSH 升级后只要
//   本插件仍在，删除就仍然可用；即使某个版本缺少拆除能力，本插件也会给出可操作
//   的错误提示，而不是静默失败。
export const name = "session-delete";

/** 唯一硬依赖：没有 /api 通道就没有浏览器入口。其余服务按需解析并给出明确错误。 */
export const inject = ["connection"];

/** 本插件在浏览器端的唯一入口路径。 */
const CHANNEL_PATH = "/api/dsd";

/** 稳定的业务错误。 */
class DeleteError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 统一的成功响应体。 */
const okResponse = (value) => Response.json({ ok: true, value });

/** 统一的失败响应体（HTTP 200 + 业务错误，便于浏览器端读取 message）。 */
const failResponse = (error) => Response.json({
  ok: false,
  error: {
    code: typeof error?.code === "string" ? error.code : "internal",
    message: error?.message ?? String(error),
    details: {},
  },
});

/** 解析一个必需服务，缺失时给出指名道姓的错误。 */
function need(s, name) {
  const service = s.get(name);
  if (service === undefined) throw new DeleteError("internal", `宿主当前未提供 "${name}" 服务，无法删除会话`);
  return service;
}

/** 读取一个会话的持久化头（先看活动会话，再查冷会话索引）。 */
async function resolveHeader(s, sessionId) {
  const sessions = need(s, "sessions");
  const live = sessions.get(sessionId);
  if (live !== undefined) return live.header;
  const records = await need(s, "sessionQuery").listSessions();
  for (const record of records) if (String(record?.header?.id) === sessionId) return record.header;
  return undefined;
}

/**
 * 子代理围栏：与官方 hasApiSessionSubagentOwner 同义。
 * 子代理会话，或由其它 Agent 运行时拥有的会话，不允许从侧边栏直接删除。
 */
function ownedBySubagentRouting(s, header, agent) {
  if (header.origin === "subagent") return true;
  const parentId = header.parentSession;
  if (parentId === undefined || agent === undefined) return false;
  const agents = s.get("agents");
  const parent = agents?.get(parentId);
  return parent !== undefined && agents.isOwnedBy(agent.id, parent);
}

/** 让活动 Agent 变得可删除：先 flush，再走 0.1.x 补丁钩子或 0.2 的公开拆除原语。 */
async function tearDownLiveAgent(s, sessionId) {
  const sessions = need(s, "sessions");
  const live = sessions.get(sessionId);
  if (live !== undefined) {
    try {
      /* 先 flush：写入协调器的 write-behind 可能在 unlink 之后重新落盘，
         把「已删除」的会话复活在下次列表里。 */
      await sessions.flush(live);
    } catch { /* flush 失败不阻断拆除 */ }
  }
  const controller = s.get("sessionController");
  /* 优先用「保留句柄」拆除：AgentHandle 只发给创建者，控制器保留的句柄是官方
     认可的拆除路径。0.2 起 `ApiSessionAgentController.disposeAgent(sessionId)`
     是官方 API（挂在 sessionController.agents 上），0.1.x 时代它由补丁加在同一
     位置；两种形状（agents 上 / 服务本身）都试一遍。 */
  for (const holder of [controller?.agents, controller]) {
    const hook = holder?.disposeAgent;
    if (typeof hook !== "function") continue;
    const disposed = await hook.call(holder, sessionId);
    if (disposed === false) {
      throw new DeleteError("agent-busy", `无法停止会话 "${sessionId}" 的运行时（非本进程 API 创建），未执行删除`);
    }
    return;
  }
  /* 兜底：用公开注册表复刻官方 agent-loop 的 dispose 顺序
     （cancel → whenIdle → scope.dispose → detach agent → detach session）。
     两次 detachEntered 分别发出 agent/disposed 与 session/disposed，后者由
     session-controller 转成 api-session/removed 广播给浏览器。 */
  const agents = s.get("agents");
  const entry = typeof agents?.store?.get === "function" ? agents.store.get(sessionId) : undefined;
  if (entry === undefined || entry === null) return; /* 冷会话：没有运行时需要拆除 */
  entry.agent.cancel({ kind: "disposed" });
  if (typeof entry.agent.whenIdle === "function") await entry.agent.whenIdle();
  const scope = entry.agent.scope;
  if (scope !== undefined && scope !== null && typeof scope.dispose === "function") await scope.dispose();
  const agentEntry = agents.store.get(sessionId);
  if (agentEntry !== undefined && typeof agents.detachEntered === "function") agents.detachEntered(agentEntry);
  const sessionEntry = typeof sessions.store?.get === "function" ? sessions.store.get(sessionId) : undefined;
  if (sessionEntry !== undefined && typeof sessions.detachEntered === "function") sessions.detachEntered(sessionEntry);
}

/** 从各工作区解绑（失败只记录，不阻断删除）。 */
async function detachFromWorkspaces(s, sessionId) {
  const registry = s.get("workspaceRegistry");
  if (registry === undefined) return;
  for (const workspace of registry.list()) {
    if (!workspace.sessionIds.includes(sessionId)) continue;
    try {
      await workspace.detachSession(sessionId);
    } catch { /* 单个工作区解绑失败不阻断删除 */ }
  }
}

/**
 * 删除一个会话的持久化产物。
 * 存储形态：<root>/<cwd slug>/<sessionId>/session.jsonl.zstd，删除整个 sessionId 目录。
 */
async function removeArtifacts(s, header) {
  const persistence = need(s, "sessionPersistence");
  if (typeof persistence.locate !== "function") {
    throw new DeleteError("backend-unsupported", "当前持久化后端不提供 locate()，无法定位会话文件");
  }
  const location = persistence.locate(header);
  if (location === undefined || typeof location.path !== "string") {
    throw new DeleteError("backend-unsupported", "持久化后端未能定位该会话的文件路径");
  }
  const { rm } = await import("node:fs/promises");
  const { dirname, basename } = await import("node:path");
  let removed = false;
  try {
    await rm(location.path, { force: true });
    removed = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  /* 只在该目录确实以本会话 id 命名时才递归删除，避免误删更大范围。 */
  const dir = dirname(location.path);
  if (basename(dir) === String(header.id)) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch { /* 目录清理是尽力而为 */ }
  }
  return removed;
}

/** 探测删除能力（浏览器端可据此给出可操作提示）。 */
async function probe(s) {
  const controller = s.get("sessionController");
  const agents = s.get("agents");
  const sessions = s.get("sessions");
  const disposeOnAgents = typeof controller?.agents?.disposeAgent === "function";
  const disposeOnService = typeof controller?.disposeAgent === "function";
  const nativeTeardown = typeof agents?.store?.get === "function"
    && typeof agents?.detachEntered === "function"
    && (typeof sessions?.detachEntered === "function" || sessions?.store === undefined);
  return {
    disposedHook: disposeOnAgents || disposeOnService,
    disposeOnAgents,
    disposeOnService,
    nativeTeardown,
    canStopLive: disposeOnAgents || disposeOnService || nativeTeardown,
    located: typeof s.get("sessionPersistence")?.locate === "function",
    /* 诊断：控制器实际暴露了哪些成员（升级后排查用）。 */
    controllerKeys: controller === undefined || controller === null ? [] : Object.keys(controller).slice(0, 40),
  };
}

/** 删除一个会话。 */
async function deleteSession(s, sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new DeleteError("bad-request", "sessionId 不能为空");
  }
  const sessions = need(s, "sessions");
  const agents = s.get("agents");
  const live = sessions.get(sessionId);
  const agent = agents?.get(sessionId);
  const header = await resolveHeader(s, sessionId);
  if (header === undefined) return { removed: false, reason: "not-found" };

  if (ownedBySubagentRouting(s, header, agent)) {
    throw new DeleteError("agent-busy", `会话 "${sessionId}" 由子代理路由拥有，无法从侧边栏删除`);
  }

  if (live !== undefined || agent !== undefined) await tearDownLiveAgent(s, sessionId);

  await detachFromWorkspaces(s, sessionId);
  const artifactRemoved = await removeArtifacts(s, header);

  /* 冷会话删除不会触发官方的 session/disposed，因此直接广播同一条转发事件，
     让所有浏览器立刻把该行从侧边栏移除（该事件在官方转发白名单内）。 */
  s.emit("api-session/removed", sessionId);
  return { removed: true, artifactRemoved };
}

/** 分发一个端点调用。 */
async function dispatch(s, endpoint, payload) {
  switch (endpoint) {
    case "probe":
      return await probe(s);
    case "delete":
      return await deleteSession(s, String(payload?.sessionId ?? ""));
    default:
      throw new DeleteError("bad-request", `未知端点 ${endpoint}`);
  }
}

function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: CHANNEL_PATH,
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json(
          { ok: false, error: { code: "bad-request", message: "请求体不是 JSON", details: {} } },
          { status: 400 },
        );
      }
      const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
      try {
        return okResponse(await dispatch(ctx, endpoint, body?.payload));
      } catch (error) {
        return failResponse(error);
      }
    },
  }), "session-delete: /api/dsd route");
}

export { apply, CHANNEL_PATH, deleteSession, probe };
