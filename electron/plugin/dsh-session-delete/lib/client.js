// dsh-session-delete — 浏览器半端（DSH 0.2+）
//
// 往官方扩展槽位 `sidebar.workspaces.session.menu.item` 注册「删除会话」菜单项，
// 并在 `shell.overlay` 注册确认弹窗；真正的删除由宿主半端经 `/api/dsd` 执行
// （停止活动 Agent、解绑工作区、删除持久化日志，并广播 api-session/removed，
// 侧边栏因此自动移除该行）。
//
// 0.2 起不再需要任何补丁：菜单入口走官方槽位，删除能力走插件自己的 HTTP 路由
// （0.1.x 时代靠补丁加生成式 RPC 端点的做法已停用，见 dsh-client/legacy/）。
//
// 依赖：react 与 @deepseek-ai/dsh-client-ui-primitives 都是 shell 的静态模块
// （见 dsh-web-frontend 的 staticModules 表），直接 require 即可。
window.__ModuleLoader__.load({
	id: "dsh-session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/** 宿主半端暴露的唯一入口。 */
		const CHANNEL_PATH = "/api/dsd";

		/** 中英双语文案（跟随浏览器语言；不引入 locale 服务）。 */
		function pick(zh, en) {
			const lang = typeof navigator !== "undefined" && typeof navigator.language === "string" ? navigator.language.toLowerCase() : "";
			return lang.startsWith("en") ? en : zh;
		}

		/** 极简快照 store：菜单项与确认弹窗共享「待删除目标」。 */
		function createStore(initial) {
			let snapshot = initial;
			const listeners = new Set();
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => { listeners.delete(listener); };
				},
				set: (next) => {
					if (next === snapshot) return;
					snapshot = next;
					for (const listener of [...listeners]) { try { listener(); } catch { /* 单个订阅者出错不影响其它订阅者 */ } }
				}
			};
		}

		/** 待确认的删除目标：`{ sessionId, title } | null`。 */
		const pending = createStore(null);

		/**
		 * 调宿主插件：`POST /api/dsd`，请求体 `{ endpoint, payload }`。
		 * 宿主统一回 `200 + { ok, value|error }`；失败时抛出带 `code` 的错误。
		 */
		async function callHost(endpoint, payload) {
			const response = await fetch(CHANNEL_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ endpoint, payload })
			});
			let body;
			try { body = await response.json(); } catch { body = void 0; }
			if (body !== void 0 && body.ok === true) return body.value;
			const error = new Error(body?.error?.message ?? `请求失败（HTTP ${response.status}）`);
			if (typeof body?.error?.code === "string") error.code = body.error.code;
			throw error;
		}

		/** 把宿主错误码翻译成可操作的提示。 */
		function explain(error) {
			const code = error?.code;
			if (code === "patch-missing" || code === "agent-busy") return pick("该会话仍在运行，当前宿主无法停止它：请先停止会话再删除，或更新桌面客户端后重启 DSH。", "This session is still running and the host cannot stop it yet: stop the session first, or update the desktop client and restart DSH.");
			if (code === "backend-unsupported") return pick("当前持久化后端不支持定位会话文件，无法删除。", "The active persistence backend cannot locate the session file, so it cannot be deleted.");
			if (code === "bad-request") return pick("请求被宿主拒绝（参数不合法）。", "The host rejected the request (invalid arguments).");
			return error?.message ?? String(error);
		}

		/** 侧边栏会话「…」菜单里的「删除会话」（排在归档之后）。 */
		function DeleteSessionMenuItem(props) {
			const { sessionId, displayTitle, useMenuOpenState, openDeleteConfirm } = props;
			const openState = typeof useMenuOpenState === "function" ? useMenuOpenState() : void 0;
			const setMenuOpen = Array.isArray(openState) && typeof openState[1] === "function" ? openState[1] : () => {};
			return React.createElement(primitives.MenuItemButton, {
				danger: true,
				separatorBefore: true,
				icon: React.createElement(primitives.IconTrashOutlineRegular, { size: 14 }),
				onSelect: () => {
					if (typeof setMenuOpen === "function") setMenuOpen(false);
					if (typeof openDeleteConfirm === "function") openDeleteConfirm({ sessionId, title: displayTitle === void 0 ? "" : displayTitle });
				}
			}, pick("删除会话", "Delete session"));
		}

		/** 确认弹窗（shell.overlay）：没有待确认目标时不渲染任何东西。 */
		function DeleteSessionConfirmDialog(props) {
			const { useDeleteTarget, closeDeleteConfirm, deleteSession } = props;
			const target = typeof useDeleteTarget === "function" ? useDeleteTarget((value) => value) : null;
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			if (target === null || target === void 0) return null;
			const close = () => {
				if (busy) return;
				setError(null);
				if (typeof closeDeleteConfirm === "function") closeDeleteConfirm();
			};
			const confirm = () => {
				if (busy) return;
				setBusy(true);
				setError(null);
				Promise.resolve()
					.then(() => (typeof deleteSession === "function" ? deleteSession(target.sessionId) : callHost("delete", { sessionId: target.sessionId })))
					.then(() => {
						setBusy(false);
						if (typeof closeDeleteConfirm === "function") closeDeleteConfirm();
					})
					.catch((reason) => {
						setBusy(false);
						setError(explain(reason));
					});
			};
			const name = target.title !== void 0 && target.title !== "" ? target.title : target.sessionId;
			return React.createElement(primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: pick("关闭", "Close"),
				title: pick("删除会话", "Delete session"),
				description: pick(
					`将永久删除会话「${name}」及其全部对话记录，此操作不可撤销。`,
					`This permanently deletes session “${name}” and all of its records. This cannot be undone.`
				),
				footer: React.createElement(React.Fragment, null,
					React.createElement(primitives.Button, { variant: "outline", disabled: busy, onClick: close }, pick("取消", "Cancel")),
					React.createElement(primitives.Button, { variant: "outline", disabled: busy, onClick: confirm }, pick(busy ? "正在删除…" : "删除", busy ? "Deleting…" : "Delete"))
				),
				children: [
					busy ? React.createElement("div", { key: "busy", role: "status", style: { fontSize: 12, opacity: 0.7 } }, pick("正在删除会话…", "Deleting session…")) : null,
					error !== null ? React.createElement("div", { key: "error", role: "alert", style: { fontSize: 12, color: "#e5484d", marginTop: 6 } }, error) : null
				]
			});
		}

		/** 需要的服务：slots（两个槽位）。删除走 /api/dsd，不需要任何 RPC 服务。 */
		const inject = ["slots"];

		/**
		 * 注册菜单项与确认弹窗；两者共享同一份注入面（同一个 pending store）。
		 * @param ctx - 浏览器端 cordis 上下文。
		 */
		function apply(ctx) {
			const faces = () => ({
				useDeleteTarget: (select) => {
					const value = React.useSyncExternalStore(pending.subscribe, pending.getSnapshot, pending.getSnapshot);
					return typeof select === "function" ? select(value) : value;
				},
				openDeleteConfirm: (target) => pending.set(target),
				closeDeleteConfirm: () => pending.set(null),
				deleteSession: (sessionId) => callHost("delete", { sessionId })
			});
			ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
				name: "sidebar.workspaces.session.menu.item",
				id: "delete-session",
				order: 500,
				inject: faces
			}, DeleteSessionMenuItem));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "session-delete-confirm",
				inject: faces
			}, DeleteSessionConfirmDialog));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__internals = { CHANNEL_PATH, callHost, createStore, explain, pending, DeleteSessionConfirmDialog, DeleteSessionMenuItem };
		return module.exports;
	}
});
