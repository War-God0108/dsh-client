// dsh-session-delete 宿主半端测试（不需要 DSH 在跑）
//
// 运行：node test-session-delete-host.mjs
//
// 用假的服务注册表驱动真实的 deleteSession / probe，覆盖：
//   · 官方「保留句柄」拆除（0.2 的 sessionController.agents.disposeAgent，
//     以及服务自身暴露 disposeAgent 的旧形状）优先、且不再走注册表兜底；
//   · 没有拆除 API 时用公开注册表复刻官方 dispose 顺序
//     （cancel → whenIdle → scope.dispose → detach agent → detach session）；
//   · 工作区解绑、产物文件与目录清理、事件广播；
//   · 冷会话、未知会话、子代理围栏与能力探测。
// 临时目录用完即删。
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { deleteSession, probe } = await import(new URL('./electron/plugin/dsh-session-delete/lib/index.js', import.meta.url).href);

let failed = 0;
function assert(condition, message) {
	if (condition) console.log(`  ✓ ${message}`);
	else { failed += 1; console.error(`  ✗ ${message}`); }
}

const root = join(tmpdir(), `dsh-sd-test-${process.pid}`);

/**
 * 造一个会话 + 服务注册表。
 * @param id - 会话 id。
 * @param options - `live` 是否活动、`artifact` 是否落产物文件、`controller` 会话控制器形状、`subagent` 是否子代理会话、`workspaces` 是否带工作区。
 * @returns ctx、调用顺序数组、产物目录。
 */
function makeFixture(id, options = {}) {
	const live = options.live !== false;
	const order = [];
	const dir = join(root, id, id);
	if (options.artifact !== false) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'session.jsonl'), '{}\n', 'utf8');
	}
	const machine = {
		cancel: (cause) => order.push(`cancel:${cause?.kind}`),
		whenIdle: async () => { order.push('whenIdle'); },
		scope: { dispose: async () => { order.push('scope.dispose'); } }
	};
	const header = { id, cwd: 'C:/work', origin: options.subagent === true ? 'subagent' : 'user' };
	const session = { id, header };
	const services = {
		sessions: {
			get: () => (live ? session : undefined),
			flush: async () => { order.push('flush'); },
			store: new Map(live ? [[id, { id, session }]] : []),
			detachEntered: () => { order.push('detach-session'); }
		},
		agents: {
			get: () => (live ? machine : undefined),
			store: new Map(live ? [[id, { id, agent: machine }]] : []),
			detachEntered: () => { order.push('detach-agent'); },
			isOwnedBy: () => false
		},
		sessionQuery: { listSessions: async () => [{ header }] },
		sessionPersistence: { locate: () => ({ path: join(dir, 'session.jsonl') }) },
		workspaceRegistry: options.workspaces === false ? undefined : {
			list: () => [{
				workspaceId: 'ws-1',
				sessionIds: [id],
				detachSession: async (target) => { order.push(`detach-workspace:${target}`); }
			}]
		}
	};
	if (options.controller !== undefined) services.sessionController = options.controller;
	const ctx = { get: (name) => services[name], emit: (event) => { order.push(`emit:${event}`); } };
	return { ctx, order, dir };
}

// ── 1) 兜底路径：没有拆除 API 时用公开注册表原语 ───────────────────────────
{
	const { ctx, order, dir } = makeFixture('sess-live-1');
	const capabilities = await probe(ctx);
	assert(capabilities.disposedHook === false, 'probe: 没有任何 disposeAgent 时 disposedHook=false');
	assert(capabilities.nativeTeardown === true, 'probe: 公开原语可用（nativeTeardown=true）');
	assert(capabilities.canStopLive === true, 'probe: 活动会话可拆除（canStopLive=true）');
	assert(capabilities.located === true, 'probe: 持久化后端可定位文件');
	assert(Array.isArray(capabilities.controllerKeys), 'probe: 带 controllerKeys 诊断字段');

	const result = await deleteSession(ctx, 'sess-live-1');
	const expected = ['flush', 'cancel:disposed', 'whenIdle', 'scope.dispose', 'detach-agent', 'detach-session', 'detach-workspace:sess-live-1', 'emit:api-session/removed'];
	assert(JSON.stringify(order) === JSON.stringify(expected), `兜底拆除顺序与官方 dispose 一致（${order.join(' → ')}）`);
	assert(result.removed === true && result.artifactRemoved === true, '返回 {removed:true, artifactRemoved:true}');
	assert(!existsSync(join(dir, 'session.jsonl')) && !existsSync(dir), '持久化文件与会话目录已删除');
}

// ── 2) 官方路径：sessionController.agents.disposeAgent 优先 ────────────────
{
	const controller = { agents: {} };
	const { ctx, order, dir } = makeFixture('sess-official-1', { controller });
	controller.agents.disposeAgent = async (sessionId) => { order.push(`disposeAgent:${sessionId}`); return true; };

	const capabilities = await probe(ctx);
	assert(capabilities.disposeOnAgents === true && capabilities.disposedHook === true, 'probe: 识别到官方 agents.disposeAgent');
	assert(capabilities.controllerKeys.includes('agents'), 'probe: 诊断字段列出 controller 成员');

	const result = await deleteSession(ctx, 'sess-official-1');
	const expected = ['flush', 'disposeAgent:sess-official-1', 'detach-workspace:sess-official-1', 'emit:api-session/removed'];
	assert(JSON.stringify(order) === JSON.stringify(expected), `官方拆除路径优先、不走注册表兜底（${order.join(' → ')}）`);
	assert(result.removed === true && result.artifactRemoved === true, '官方路径同样完成清理');
	assert(!existsSync(dir), '官方路径下产物目录已删除');
}

// ── 3) 服务自身暴露 disposeAgent 的旧形状 ─────────────────────────────────
{
	const { ctx, order } = makeFixture('sess-service-1', { controller: {} });
	ctx.get('sessionController').disposeAgent = async (sessionId) => { order.push(`serviceDispose:${sessionId}`); return true; };
	await deleteSession(ctx, 'sess-service-1');
	assert(order.includes('serviceDispose:sess-service-1'), '服务自身暴露的 disposeAgent 也会被使用');
	assert(!order.some((step) => step.startsWith('cancel:')), '使用 disposeAgent 时不再走注册表兜底');
}

// ── 4) disposeAgent 返回 false → agent-busy ───────────────────────────────
{
	const { ctx } = makeFixture('sess-busy-1', { controller: { agents: { disposeAgent: async () => false } } });
	let refusal = null;
	try { await deleteSession(ctx, 'sess-busy-1'); } catch (error) { refusal = error; }
	assert(refusal !== null && refusal.code === 'agent-busy', 'disposeAgent 返回 false 时报 agent-busy（不误删）');
}

// ── 5) 冷会话：没有运行时也要能删 ─────────────────────────────────────────
{
	const { ctx, order } = makeFixture('sess-cold-1', { live: false });
	const result = await deleteSession(ctx, 'sess-cold-1');
	assert(result.removed === true && result.artifactRemoved === true, '冷会话可删除');
	assert(!order.some((step) => step.startsWith('cancel:')), '冷会话不触发任何拆除');
}

// ── 6) 未知会话与子代理围栏 ───────────────────────────────────────────────
{
	const { ctx } = makeFixture('sess-x', { live: false, artifact: false, workspaces: false });
	const missing = await deleteSession(ctx, 'nope');
	assert(missing.removed === false && missing.reason === 'not-found', '未知会话返回 not-found（不抛错）');
}
{
	const { ctx } = makeFixture('sub-1', { live: false, artifact: false, subagent: true, workspaces: false });
	let refusal = null;
	try { await deleteSession(ctx, 'sub-1'); } catch (error) { refusal = error; }
	assert(refusal !== null && refusal.code === 'agent-busy', '子代理拥有的会话被拒绝（agent-busy）');
}

rmSync(root, { recursive: true, force: true });
console.log(failed === 0 ? '\n全部通过 ✔' : `\n${failed} 项失败 ✘`);
process.exit(failed === 0 ? 0 : 1);
