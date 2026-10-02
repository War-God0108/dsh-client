// dsh-session-delete 浏览器半端冒烟测试（不需要 DSH 在跑，也不依赖磁盘上的 react）
//
// 运行：node test-session-delete-client.mjs
//
// 做法：捕获 bundle 的 __ModuleLoader__.load，用 React 桩件（createElement /
// useState / useSyncExternalStore）与 UI 原语桩件运行真实代码，覆盖：
// 槽位注册、菜单项交互、确认弹窗渲染、注入面共享状态，以及 /api/dsd 的请求
// 与错误映射。React 桩件让 setState 变成"记录但不重渲染"，因此断言的是
// 状态更新意图与最终调用，而不是 DOM。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

let failed = 0;
function assert(condition, message) {
	if (condition) console.log(`  ✓ ${message}`);
	else { failed += 1; console.error(`  ✗ ${message}`); }
}

// ── React 桩件（只覆盖本插件用到的 API） ───────────────────────────────────
const stateUpdates = [];
const reactStub = {
	Fragment: Symbol('Fragment'),
	createElement: (type, props, ...children) => {
		const merged = { ...(props === null || props === undefined ? {} : props) };
		if (children.length === 1) merged.children = children[0];
		else if (children.length > 1) merged.children = children;
		return { type, props: merged };
	},
	useState: (init) => {
		const value = typeof init === 'function' ? init() : init;
		return [value, (next) => stateUpdates.push(next)];
	},
	useEffect: () => {},
	useRef: (init) => ({ current: init }),
	useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot()
};

const primitivesStub = {
	MenuItemButton: ({ children, onSelect, danger, separatorBefore }) =>
		reactStub.createElement('button', { 'data-prim': 'MenuItemButton', 'data-danger': danger === true, 'data-separator': separatorBefore === true, onClick: onSelect }, children),
	Modal: ({ open, title, description, children, footer, onClose }) =>
		open === true ? reactStub.createElement('div', { 'data-prim': 'Modal', onClick: onClose }, title, description, children, footer) : null,
	Button: ({ children, onClick, disabled, variant }) =>
		reactStub.createElement('button', { 'data-prim': 'Button', 'data-variant': variant, disabled: disabled === true, onClick }, children),
	IconTrashOutlineRegular: () => reactStub.createElement('svg', { 'data-prim': 'trash' })
};

// ── 环境：__ModuleLoader__ 捕获 + fetch 桩 ─────────────────────────────────
let registered = null;
globalThis.window = globalThis;
/* Node 26 的 globalThis.navigator 只有 getter，所以把可变 navigator 作为参数传给 bundle。 */
const nav = { language: 'zh-CN' };
globalThis.window.__ModuleLoader__ = { load: (entry) => { registered = entry; } };

const calls = [];
let fetchImpl = async (url, init) => {
	calls.push({ url, init, body: JSON.parse(init.body) });
	return { ok: true, status: 200, json: async () => ({ ok: true, value: { removed: true } }) };
};
const fetchStub = (...args) => fetchImpl(...args);

// ── 1) 载入 bundle ─────────────────────────────────────────────────────────
const source = readFileSync(join(here, 'electron', 'plugin', 'dsh-session-delete', 'lib', 'client.js'), 'utf8');
new Function('window', 'navigator', 'fetch', source)(globalThis.window, nav, fetchStub);
assert(registered !== null, 'bundle 调用了 window.__ModuleLoader__.load');
assert(registered.id === 'dsh-session-delete', 'load id 为 dsh-session-delete');

let exportsObject = null;
try {
	exportsObject = registered.factory((spec) => {
		if (spec === 'react') return reactStub;
		if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub;
		throw new Error(`unexpected require: ${spec}`);
	});
} catch (error) {
	assert(false, `factory 执行无异常: ${error.message}`);
	process.exit(1);
}
assert(typeof exportsObject.apply === 'function', '导出 apply');
assert(Array.isArray(exportsObject.inject) && exportsObject.inject.includes('slots'), 'inject 包含 slots');

// ── 2) 槽位注册 ────────────────────────────────────────────────────────────
const registrations = [];
const ctx = {
	slots: {
		register: (spec, component) => { registrations.push({ spec, component }); return () => {}; },
		inject: (name, factory) => { factory(); return () => {}; }
	}
};
exportsObject.apply(ctx);
assert(registrations.length === 2, '注册了两个槽位条目（菜单项 + 确认弹窗）');
const menu = registrations.find((entry) => entry.spec.name === 'sidebar.workspaces.session.menu.item');
const dialog = registrations.find((entry) => entry.spec.name === 'shell.overlay');
assert(menu !== undefined, '菜单项注册到官方槽位 sidebar.workspaces.session.menu.item');
assert(dialog !== undefined, '确认弹窗注册到 shell.overlay');
assert(menu.spec.id === 'delete-session' && menu.spec.order === 500, '菜单项 id=delete-session、order=500（排在官方归档项之后）');
const face = menu.spec.inject();
assert(face === dialog.spec.inject() || typeof face.openDeleteConfirm === 'function', '注入面工厂可用');
assert(typeof face.openDeleteConfirm === 'function' && typeof face.closeDeleteConfirm === 'function'
	&& typeof face.deleteSession === 'function' && typeof face.useDeleteTarget === 'function',
	'注入面提供 openDeleteConfirm / closeDeleteConfirm / deleteSession / useDeleteTarget');

// ── 3) 菜单项交互 ──────────────────────────────────────────────────────────
const closedCalls = [];
const menuElement = menu.component({
	sessionId: 'sess-1',
	displayTitle: '测试会话',
	useMenuOpenState: () => [true, (next) => closedCalls.push(next)],
	openDeleteConfirm: face.openDeleteConfirm
});
assert(menuElement.type === primitivesStub.MenuItemButton, '菜单项渲染 MenuItemButton');
assert(menuElement.props.danger === true, '菜单项为危险样式（danger）');
assert(menuElement.props.children === '删除会话', '中文文案为「删除会话」');
menuElement.props.onSelect();
assert(closedCalls.length === 1 && closedCalls[0] === false, '点击后关闭三点菜单');
assert(face.useDeleteTarget((value) => value)?.sessionId === 'sess-1', '点击后把会话交给共享的待确认状态');

nav.language = 'en-US';
const enElement = menu.component({ sessionId: 's1', displayTitle: 'T', useMenuOpenState: () => [true, () => {}], openDeleteConfirm: () => {} });
assert(enElement.props.children === 'Delete session', '英文环境文案为 Delete session');nav.language = 'zh-CN';

// ── 4) 确认弹窗：渲染 → 确认 → 调接口 → 关闭 ───────────────────────────────
const dialogProps = {
	useDeleteTarget: face.useDeleteTarget,
	closeDeleteConfirm: face.closeDeleteConfirm,
	deleteSession: face.deleteSession
};
const dialogElement = dialog.component(dialogProps);
assert(dialogElement.type === primitivesStub.Modal, '有待确认目标时渲染 Modal');
assert(dialogElement.props.title === '删除会话', '弹窗标题为「删除会话」');
const footer = dialogElement.props.footer;
const buttons = footer.props.children;
assert(Array.isArray(buttons) && buttons.length === 2, '弹窗底部有「取消 / 删除」两个按钮');
assert(buttons[0].props.children === '取消' && buttons[1].props.children === '删除', '按钮文案为 取消 / 删除');

calls.length = 0;
buttons[1].props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
assert(calls.length === 1 && calls[0].url === '/api/dsd', '点击「删除」调用 /api/dsd');
assert(calls[0].body.endpoint === 'delete' && calls[0].body.payload.sessionId === 'sess-1', '请求体为 {endpoint:"delete", payload:{sessionId}}');
assert(face.useDeleteTarget((value) => value) === null, '成功后清空待确认目标（弹窗关闭）');

// 取消只关弹窗，不发起请求
face.openDeleteConfirm({ sessionId: 'sess-2', title: '另一个会话' });
calls.length = 0;
dialog.component(dialogProps).props.footer.props.children[0].props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
assert(calls.length === 0 && face.useDeleteTarget((value) => value) === null, '点击「取消」不发起请求并关闭弹窗');

// 无目标时什么都不渲染
assert(dialog.component(dialogProps) === null, '没有待确认目标时不渲染任何内容（shell.overlay 常驻）');

// ── 5) 错误路径：与会话仍在运行等业务错误 ──────────────────────────────────
face.openDeleteConfirm({ sessionId: 'sess-3', title: '运行中的会话' });
stateUpdates.length = 0;
fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: { code: 'patch-missing', message: '需要补丁' } }) });
dialog.component(dialogProps).props.footer.props.children[1].props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
assert(stateUpdates.some((value) => typeof value === 'string' && value.includes('仍在运行')), '业务错误被翻译成「会话仍在运行」提示');
assert(face.useDeleteTarget((value) => value)?.sessionId === 'sess-3', '失败时保留弹窗（目标未被清空）');

// 非 JSON 响应按 HTTP 状态报错
stateUpdates.length = 0;
fetchImpl = async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } });
dialog.component(dialogProps).props.footer.props.children[1].props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
assert(stateUpdates.some((value) => typeof value === 'string' && value.includes('500')), '非 JSON 响应按 HTTP 状态报错');

console.log(failed === 0 ? '\n全部通过 ✔' : `\n${failed} 项失败 ✘`);
process.exit(failed === 0 ? 0 : 1);
