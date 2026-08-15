/* ============================================================
   DSH CLIENT — DeepSeek Harness cockpit
   Wire protocol: POST /api/<method> (unary) + POST /api/respond
   + WS downlinks /api/events.mux and /api/events.host
   ============================================================ */
'use strict';

/* ---------------- RPC layer ---------------- */
let rpcSeq = 0;
function rpcId() { return `dshc-${Date.now().toString(36)}-${(++rpcSeq).toString(36)}`; }

async function rpc(method, payload, id) {
  const rid = id ?? rpcId();
  const res = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: rid, method, payload: payload ?? {} }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${method}`);
  const msg = await res.json();
  if (msg.type !== 'server-response' || msg.rpcId !== rid) throw new Error(`bad envelope for ${method}`);
  if (!msg.result.ok) {
    const e = new Error(`RPC ${method}: ${msg.result.error.message}`);
    e.code = msg.result.error.code;
    e.details = msg.result.error.details;
    throw e;
  }
  return msg.result.value;
}

/** Answer a server-request (question) via POST /api/respond. */
async function respond(rpcIdStr, value) {
  const res = await fetch('/api/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-response',
      rpcId: rpcIdStr,
      result: { ok: true, value },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for respond`);
  return res.json();
}

/* ---------------- helpers ---------------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}
function fmtRel(ms) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return new Date(ms).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}
function fmtTokens(n) {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/* ---------------- minimal markdown ---------------- */
function escapeHtml(s) {
  return esc(s);
}
function renderInline(src) {
  let s = escapeHtml(src);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}
function renderMarkdown(src) {
  const lines = String(src ?? '').split(/\r?\n/);
  let html = '';
  let i = 0;
  let inList = false;
  let listType = null;
  const closeList = () => { if (inList) { html += `</${listType}>`; inList = false; listType = null; } };

  while (i < lines.length) {
    const line = lines[i];
    // fenced code
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      closeList();
      const lang = fence[1];
      i++;
      const buf = [];
      while (i < lines.length && !lines[i].startsWith('```')) { buf.push(lines[i]); i++; }
      i++; // closing fence
      html += `<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`;
      continue;
    }
    // headings
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) { closeList(); const lv = h[1].length; html += `<h${lv}>${renderInline(h[2])}</h${lv}>`; i++; continue; }
    // hr
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { closeList(); html += '<hr/>'; i++; continue; }
    // blockquote
    if (/^\s*>\s?/.test(line)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      html += `<blockquote>${renderInline(buf.join(' '))}</blockquote>`;
      continue;
    }
    // list
    const ul = line.match(/^\s*[-*+]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      if (!inList) { inList = true; listType = tag; html += `<${tag}>`; }
      else if (listType !== tag) { closeList(); inList = true; listType = tag; html += `<${tag}>`; }
      html += `<li>${renderInline((ul ?? ol)[1])}</li>`;
      i++;
      continue;
    }
    closeList();
    // blank
    if (!line.trim()) { i++; continue; }
    html += `<p>${renderInline(line)}</p>`;
    i++;
  }
  closeList();
  return html;
}

/* ---------------- state ---------------- */
const state = {
  sessions: [],            // SessionSummary[]
  current: null,           // sessionId
  nodes: [],               // surface nodes for current session
  streaming: null,         // {node, turn, step} streaming assistant node
  running: false,
  queueCount: 0,
  projections: {},         // per-session projection values
  host: null,
  wsMux: null,
  wsHost: null,
  question: null,          // pending question frame
  conn: 'connecting',      // connecting | on | off
};

/* ---------------- connection / host ---------------- */
async function loadHost() {
  try {
    state.host = await rpc('host.describe', {});
    renderHost();
  } catch (e) {
    setConn('off');
    console.error('host.describe failed', e);
  }
}

function setConn(kind) {
  state.conn = kind;
  const chip = $('chip-conn');
  chip.className = `chip ${kind === 'on' ? 'conn-on' : kind === 'off' ? 'conn-off' : 'conn-busy'}`;
  $('txt-conn').textContent = kind === 'on' ? '已连接' : kind === 'off' ? '离线' : '连接中…';
}

function renderHost() {
  if (!state.host) return;
  $('chip-model').textContent = `${state.host.provider} / ${state.host.model}`;
  $('chip-version').textContent = `v${state.host.version}`;
  $('chip-cwd').textContent = state.host.cwd;
  $('chip-cwd').title = state.host.cwd;
  $('side-foot').textContent = `target: ${location.host} → harness ${state.host.cwd}`;
}

/* ---------------- sessions ---------------- */
async function loadSessions() {
  const { items } = await rpc('session.list', {});
  state.sessions = items;
  renderSessions();
}

function sessionTitle(s) {
  const proj = s.projections?.values ?? {};
  if (proj.title) return proj.title;
  return `会话 ${s.sessionId.slice(0, 8)}`;
}

function renderSessions() {
  const list = $('session-list');
  const visible = state.sessions.filter((s) => !s.blank);
  if (!visible.length) {
    list.innerHTML = '<div class="empty">尚无会话 — 点击 ＋ NEW 创建</div>';
    return;
  }
  list.innerHTML = '';
  for (const s of visible) {
    const el = document.createElement('div');
    el.className = `session-item mono ${s.sessionId === state.current ? 'active' : ''}`;
    el.innerHTML = `
      <div class="si-title">${esc(sessionTitle(s))}</div>
      <div class="si-meta">
        <span class="si-run ${s.running ? 'on' : ''}"></span>
        <span>${fmtRel(s.updatedAt)}</span>
        ${s.cwd ? `<span class="si-cwd" title="${esc(s.cwd)}">${esc(s.cwd)}</span>` : ''}
      </div>`;
    el.addEventListener('click', () => openSession(s.sessionId));
    list.appendChild(el);
  }
}

async function createSession() {
  try {
    setConn('busy');
    const { sessionId } = await rpc('session.create', {});
    await loadSessions();
    await openSession(sessionId);
  } catch (e) {
    flashError(`新建会话失败: ${e.message}`);
  } finally {
    setConn(state.wsMux ? 'on' : 'off');
  }
}

/* ---------------- conversation model ---------------- */
function clearConversation() {
  state.nodes = [];
  state.streaming = null;
  state.running = false;
  state.queueCount = 0;
  state.question = null;
  state.projections = {};
}

/** Append a live event to the surface model. Returns true if DOM needs rebuild. */
function applyEvent(ev) {
  const d = ev.data;
  switch (ev.type) {
    case 'user/message': {
      const isHuman = d.source?.kind === 'user';
      if (isHuman) {
        // dedupe: our optimistic node carries the same rpcId
        const existing = state.nodes.find(
          (n) => n.kind === 'user' && n.rpcId && n.rpcId === d.source?.rpcId,
        );
        if (existing) {
          existing.time = ev.time;
          existing.content = d.content;
          return true;
        }
        state.nodes.push({
          kind: 'user', time: ev.time, content: d.content,
          sourceKind: 'user', rpcId: d.source?.rpcId,
        });
      } else {
        // injected context (agent-instructions / plugin snapshot / skill catalog …)
        const label = d.source?.kind ?? 'context';
        state.nodes.push({
          kind: 'context', time: ev.time, content: d.content, label,
        });
      }
      return true;
    }
    case 'assistant/chunk': {
      const key = `${d.turn}:${d.step}`;
      if (!state.streaming || state.streaming.key !== key) {
        const node = { kind: 'assistant', time: ev.time, text: '', reasoning: '', blocks: [], streaming: true, key };
        state.nodes.push(node);
        state.streaming = { node, key };
        return true;
      }
      const c = d.chunk;
      if (c.type === 'text-delta') state.streaming.node.text += c.text;
      else if (c.type === 'reasoning-delta') state.streaming.node.reasoning += c.text;
      else if (c.type === 'tool-call-delta') {
        state.streaming.node.text += `\n\n[工具调用: ${c.name ?? '…'}] ${c.argumentsDelta}`;
      }
      return false; // incremental text update only
    }
    case 'assistant/message': {
      if (state.streaming && state.streaming.key === `${d.turn}:${d.step}`) {
        state.streaming.node.streaming = false;
        state.streaming.node.text = '';
        state.streaming.node.reasoning = '';
        state.streaming.node.blocks = d.message.content ?? [];
        state.streaming.node.usage = d.usage;
        state.streaming = null;
      } else {
        state.nodes.push({
          kind: 'assistant', time: ev.time, text: '', reasoning: '',
          blocks: d.message.content ?? [], streaming: false, usage: d.usage,
        });
      }
      return true;
    }
    case 'tool/call': {
      state.nodes.push({
        kind: 'tool', time: ev.time, callId: d.callId, name: d.name,
        arguments: d.arguments, result: undefined, error: undefined,
      });
      return true;
    }
    case 'tool/result': {
      const node = state.nodes.filter((n) => n.kind === 'tool').reverse()
        .find((n) => n.callId === d.message.toolCallId) ??
        state.nodes.filter((n) => n.kind === 'tool').reverse()[0];
      if (node) { node.result = d.message; node.error = d.error; }
      return true;
    }
    case 'turn/start': {
      state.nodes.push({ kind: 'divider', turn: d.turn, start: true });
      return true;
    }
    case 'turn/end': {
      state.nodes.push({ kind: 'status', turn: d.turn, reason: d.reason });
      state.running = false;
      return true;
    }
    case 'todo/write': {
      state.projections.todos = d.todos;
      renderTelemetry();
      return false;
    }
    case 'request/header': {
      state.projections.header = d.header;
      renderTelemetry();
      return false;
    }
    default:
      return false; // ignore others (end-seed, request/context, compaction...)
  }
}

/** Fold history events into the model (events are in seq order, oldest first). */
function foldHistory(events) {
  clearConversation();
  for (const { event } of events) applyEvent(event);
}

/* ---------------- rendering ---------------- */
function renderMessages() {
  const wrap = $('messages');
  if (!state.nodes.length) {
    wrap.innerHTML = '<div class="empty">◈ 会话为空 — 发送第一条消息</div>';
    return;
  }
  wrap.innerHTML = '';
  for (const n of state.nodes) wrap.appendChild(renderNode(n));
  scrollToBottom();
}

function renderNode(n) {
  switch (n.kind) {
    case 'context': {
      const el = document.createElement('div');
      el.className = 'msg context';
      const blocks = Array.isArray(n.content) ? n.content : [{ type: 'text', text: n.content }];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      el.innerHTML = `
        <div class="msg-head"><span class="role">CTX</span><span class="time">${fmtTime(n.time)}</span>
          <span class="ctx-label mono">${esc(n.label)}</span></div>
        <div class="msg-body md">${renderMarkdown(truncate(text, 600))}</div>`;
      return el;
    }
    case 'user': {
      const el = document.createElement('div');
      el.className = 'msg user';
      const blocks = Array.isArray(n.content) ? n.content : [{ type: 'text', text: n.content }];
      const body = blocks
        .filter((b) => b.type === 'text')
        .map((b) => renderMarkdown(b.text))
        .join('');
      el.innerHTML = `
        <div class="msg-head"><span class="role">YOU</span><span class="time">${fmtTime(n.time)}</span></div>
        <div class="msg-body md">${body || '…'}</div>`;
      return el;
    }
    case 'assistant': {
      const el = document.createElement('div');
      el.className = `msg assistant${n.streaming ? ' streaming' : ''}`;
      let body = '';
      if (n.streaming) {
        const r = n.reasoning ? `<div class="reasoning" data-role="reasoning">${esc(n.reasoning)}</div>` : '';
        body = r + `<div class="md">${renderMarkdown(n.text)}</div>`;
      } else {
        for (const b of n.blocks ?? []) {
          if (b.type === 'text') body += `<div class="md">${renderMarkdown(b.text)}</div>`;
          else if (b.type === 'reasoning') body += `<div class="reasoning">${esc(b.text)}</div>`;
          else if (b.type === 'tool-call') {
            body += renderToolCard({ name: b.name, arguments: b.arguments }, null, false);
          }
        }
        if (!body) body = '<div class="md">…</div>';
      }
      const usage = n.usage ? `<span class="time">${fmtTokens(n.usage.outputTokens)} tok</span>` : '';
      el.innerHTML = `
        <div class="msg-head"><span class="role">DSH</span><span class="time">${fmtTime(n.time)}</span>${usage}</div>
        <div class="msg-body">${body}</div>`;
      return el;
    }
    case 'tool': {
      const el = document.createElement('div');
      el.className = 'msg tool';
      el.innerHTML = `
        <div class="msg-head"><span class="role">TOOL</span><span class="time">${fmtTime(n.time)}</span>
          <span class="tool-name mono">${esc(n.name)}</span></div>
        ${renderToolCard(n, n.result, n.error)}`;
      return el;
    }
    case 'divider': {
      const el = document.createElement('div');
      el.className = 'turn-divider';
      el.textContent = `— TURN ${n.turn} —`;
      return el;
    }
    case 'status': {
      const el = document.createElement('div');
      const r = n.reason;
      let txt = `▣ turn ${n.turn} 结束`;
      let cls = '';
      if (r?.kind === 'completed') txt = `✓ turn ${n.turn} 完成`;
      else if (r?.kind === 'aborted') { txt = `■ turn ${n.turn} 已中止`; cls = 'err'; }
      else if (r?.kind === 'error') { txt = `✗ turn ${n.turn} 错误: ${r.error?.message ?? ''}`; cls = 'err'; }
      else if (r?.kind === 'max-tokens') txt = `⚠ turn ${n.turn} 达到输出上限`;
      el.className = `status-line mono ${cls}`;
      el.textContent = txt;
      return el;
    }
    default:
      return document.createElement('div');
  }
}

function renderToolCard(n, result, error) {
  const open = result ? '' : ' open';
  let args;
  try { args = JSON.stringify(JSON.parse(n.arguments), null, 2); }
  catch { args = n.arguments; }
  let resultHtml = '';
  if (result) {
    const blocks = result.content ?? [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    if (error) {
      resultHtml = `<div class="tool-result-err"><span class="err mono">✗ ${esc(error.name)} (${esc(error.code)})</span>
        <pre>${esc(text || JSON.stringify(result, null, 2))}</pre></div>`;
    } else {
      resultHtml = `<div class="tool-result-ok"><span class="ok mono">✓ 完成</span>
        <pre>${esc(truncate(text || JSON.stringify(result, null, 2), 4000))}</pre></div>`;
    }
  }
  return `
    <div class="tool-card${open}" data-role="toolcard">
      <div class="tool-head mono">
        <span class="tw">⚒</span> ${esc(n.name)}
        <span class="caret">▸</span>
      </div>
      <div class="tool-body"><pre>${esc(args)}</pre>${resultHtml}</div>
    </div>`;
}

function scrollToBottom() {
  const sc = $('conv-scroll');
  requestAnimationFrame(() => { sc.scrollTop = sc.scrollHeight; });
}

function renderTelemetry() {
  const host = $('telemetry');
  const p = state.projections;
  const chips = [];
  if (p.todos) {
    const done = p.todos.filter((t) => t.status === 'completed').length;
    chips.push(`<span class="tchip">todos <b>${done}/${p.todos.length}</b></span>`);
  }
  if (p.sessionStats) {
    chips.push(`<span class="tchip">turns <b>${p.sessionStats.turns}</b></span>`);
  }
  if (p.tokenUsage) {
    chips.push(`<span class="tchip">in <b>${fmtTokens(p.tokenUsage.uncachedInputTokens)}</b> cache <b>${fmtTokens(p.tokenUsage.cacheReadTokens)}</b> out <b>${fmtTokens(p.tokenUsage.outputTokens)}</b></span>`);
  }
  if (p.contextPressure) {
    const c = p.contextPressure;
    const warn = c.projectedTokens > c.contextWindow * 0.7;
    chips.push(`<span class="tchip ${warn ? 'warn' : ''}">ctx <b>${fmtTokens(c.projectedTokens)}</b>/${fmtTokens(c.contextWindow)}</span>`);
  }
  if (p.header?.config) {
    const cfg = p.header.config;
    chips.push(`<span class="tchip">model <b>${esc(cfg.model)}</b></span>`);
  }
  host.innerHTML = chips.join('');
}

/* ---------------- conversation open / mux ---------------- */
async function openSession(sessionId) {
  state.current = sessionId;
  clearConversation();
  renderSessions();

  // title + meta from list
  const s = state.sessions.find((x) => x.sessionId === sessionId);
  $('conv-title').textContent = s ? sessionTitle(s) : '会话';
  $('conv-meta').textContent = s
    ? `id ${s.sessionId} · ${s.cwd ?? 'cwd —'} · preset ${s.agentPreset ?? '—'}`
    : '';
  $('composer').hidden = false;
  $('msg-empty').hidden = true;

  try {
    const { events, projections } = await rpc('session.history', {
      sessionId, maxMessages: 100,
    });
    foldHistory(events);
    // NOTE: must come AFTER foldHistory (which clears projections via clearConversation)
    if (projections) state.projections = projections.values ?? {};
    state.running = state.nodes.some((n) => n.kind === 'assistant' && n.streaming) || s?.running;
    renderMessages();
    renderTelemetry();
    // reconcile streamed title projection
    if (state.projections.title && state.current === sessionId) {
      $('conv-title').textContent = state.projections.title;
    }
  } catch (e) {
    flashError(`加载历史失败: ${e.message}`);
  }

  ensureMux();
  ensureHost();
}

/* ---------------- live streams ---------------- */
function ensureMux() {
  if (state.wsMux && state.wsMux.readyState <= 1) return;
  const ws = new WebSocket(`ws://${location.host}/api/events.mux`);
  state.wsMux = ws;
  ws.onopen = () => { setConn('on'); };
  ws.onmessage = (evt) => {
    let frame;
    try { frame = JSON.parse(evt.data); } catch { return; }
    if (frame.type !== 'server-request') return;
    handleMuxFrame(frame);
  };
  ws.onclose = () => {
    setConn('off');
    setTimeout(ensureMux, 2000);
    setTimeout(ensureHost, 2000);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
}

function ensureHost() {
  if (state.wsHost && state.wsHost.readyState <= 1) return;
  const ws = new WebSocket(`ws://${location.host}/api/events.host`);
  state.wsHost = ws;
  ws.onmessage = (evt) => {
    let frame;
    try { frame = JSON.parse(evt.data); } catch { return; }
    if (frame.type !== 'server-request') return;
    handleHostFrame(frame.payload);
  };
  ws.onclose = () => setTimeout(ensureHost, 2000);
}

function handleMuxFrame(frame) {
  const p = frame.payload;
  if (p.type === 'session/event') {
    if (p.sessionId !== state.current) return;
    const dirty = applyEvent(p.event);
    if (dirty) {
      renderMessages();
      renderTelemetry();
    } else if (state.streaming) {
      // incremental streaming update: patch the tail node in place
      const wrap = $('messages');
      const last = wrap.lastElementChild;
      if (last && last.classList.contains('assistant')) {
        const bodyEl = last.querySelector('.msg-body');
        const r = state.streaming.node.reasoning
          ? `<div class="reasoning" data-role="reasoning">${esc(state.streaming.node.reasoning)}</div>`
          : '';
        bodyEl.innerHTML = r + `<div class="md">${renderMarkdown(state.streaming.node.text)}</div>`;
        scrollToBottom();
      }
    }
    // running detection: turn/start sets it
    if (p.event.type === 'turn/start') { state.running = true; updateComposer(); }
    if (p.event.type === 'turn/end') { state.running = false; updateComposer(); }
    if (p.event.type === 'user/message' && p.event.data.source?.rpcId) {
      // our own optimistic message is now durable — nothing to do
    }
  } else if (p.type === 'session/projection') {
    if (p.sessionId !== state.current) return;
    state.projections[p.key] = p.value;
    if (p.key === 'title' && p.value) $('conv-title').textContent = p.value;
    renderTelemetry();
  } else if (p.type === 'session/subscribed') {
    if (p.sessionId === state.current) setConn('on');
  } else if (p.type === 'session/queue') {
    if (p.sessionId !== state.current) return;
    state.queueCount = p.items.length;
    updateComposer();
  } else if (p.type === 'question/requested') {
    if (p.sessionId !== state.current) return;
    state.question = { rpcId: frame.rpcId, questions: p.questions };
    renderQuestionCard();
  } else if (p.type === 'question/resolved') {
    if (p.sessionId !== state.current) return;
    state.question = null;
    removeQuestionCard();
  } else if (p.type === 'session/jobs') {
    // jobs snapshot — show count in telemetry
    if (p.sessionId === state.current) {
      state.jobs = p.jobs;
      renderTelemetry();
    }
  }
}

function handleHostFrame(p) {
  if (p.type === 'host/session-status') {
    const s = state.sessions.find((x) => x.sessionId === p.sessionId);
    if (s) { s.running = p.running; renderSessions(); }
    if (p.sessionId === state.current) {
      state.running = p.running;
      updateComposer();
    }
  } else if (p.type === 'host/session-added') {
    loadSessions().catch(() => {});
  } else if (p.type === 'host/agent-error') {
    if (p.sessionId === state.current) {
      flashError(`代理错误: ${p.message}`);
    }
  }
}

/* ---------------- questions ---------------- */
function renderQuestionCard() {
  removeQuestionCard();
  const q = state.question;
  if (!q) return;
  const wrap = $('messages');
  const card = document.createElement('div');
  card.className = 'msg tool';
  card.id = 'question-card';
  const items = q.questions.map((qq, qi) => {
    const opts = (qq.options ?? [])
      .map((o) => `<button class="q-opt" data-qi="${qi}" data-label="${esc(o.label)}">${esc(o.label)}</button>`)
      .join('');
    return `
      <div class="q-item">
        <div class="q-q">${esc(qq.question)}</div>
        ${qq.detail ? `<div class="q-detail">${esc(qq.detail)}</div>` : ''}
        ${qq.header ? `<div class="q-header mono">${esc(qq.header)}</div>` : ''}
        ${opts ? `<div class="q-opts">${opts}</div>` : ''}
        <input class="q-input mono" data-qi="${qi}" placeholder="${qq.options ? '或输入自定义答案…' : '输入答案…'}" />
      </div>`;
  }).join('');
  card.innerHTML = `
    <div class="msg-head"><span class="role">QUESTION</span><span class="time">${fmtTime(Date.now())}</span></div>
    <div class="msg-body">${items}
      <div class="q-actions"><button class="btn-send" id="q-submit">提交答案</button></div>
    </div>`;
  wrap.appendChild(card);
  card.querySelectorAll('.q-opt').forEach((b) => {
    b.addEventListener('click', () => {
      const qi = Number(b.dataset.qi);
      const input = card.querySelector(`.q-input[data-qi="${qi}"]`);
      if (input) input.value = b.dataset.label;
      card.querySelectorAll('.q-opt').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
    });
  });
  $('q-submit').addEventListener('click', submitQuestion);
  scrollToBottom();
}

function submitQuestion() {
  const q = state.question;
  if (!q) return;
  const answers = q.questions.map((qq, qi) => {
    const input = document.querySelector(`.q-input[data-qi="${qi}"]`);
    const sel = [...document.querySelectorAll(`.q-opt.sel[data-qi="${qi}"]`)].map((b) => b.dataset.label);
    return { id: qq.id, selected: sel, custom: input?.value && !sel.includes(input.value) ? input.value : undefined };
  });
  const payload = { sessionId: state.current, answer: { answers } };
  respond(q.rpcId, payload).catch((e) => flashError(`回答提交失败: ${e.message}`));
  state.question = null;
  removeQuestionCard();
}

function removeQuestionCard() {
  $('question-card')?.remove();
}

/* ---------------- composer / prompt ---------------- */
function updateComposer() {
  const s = state.sessions.find((x) => x.sessionId === state.current);
  const running = state.running || (s?.running && state.current === s.sessionId) || state.queueCount > 0;
  $('btn-send').disabled = running || !state.current;
  $('btn-stop').hidden = !running || !state.current;
  $('composer-hint').textContent = state.queueCount > 0
    ? `队列中 ${state.queueCount} 条待处理…`
    : state.running
      ? '代理运行中 — 可停止，队列消息将在停止后继续'
      : 'Enter 发送 · Shift+Enter 换行';
}

async function sendPrompt() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || !state.current) return;
  input.value = '';
  autoGrow();
  const rid = rpcId();
  // optimistic user message (deduped against the durable event via rpcId)
  state.nodes.push({ kind: 'user', time: Date.now(), content: [{ type: 'text', text }], sourceKind: 'user', rpcId: rid });
  state.running = true;
  renderMessages();
  updateComposer();
  try {
    await rpc('session.prompt', {
      sessionId: state.current,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, rid);
  } catch (e) {
    if (e.code !== 'agent-busy') flashError(`发送失败: ${e.message}`);
    state.running = false;
    renderMessages();
    updateComposer();
  }
}

async function stopTurn() {
  if (!state.current) return;
  try {
    await rpc('session.cancel', { sessionId: state.current });
  } catch (e) {
    flashError(`停止失败: ${e.message}`);
  }
}

/* ---------------- toast ---------------- */
let toastTimer = null;
function flashError(msg) {
  let t = $('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = `⚠ ${msg}`;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 5000);
}

/* ---------------- composer wiring ---------------- */
const inputEl = $('input');
function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + 'px';
}
inputEl.addEventListener('input', autoGrow);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendPrompt();
  }
});
$('btn-send').addEventListener('click', sendPrompt);
$('btn-stop').addEventListener('click', stopTurn);
$('btn-new').addEventListener('click', createSession);

// delegate tool card collapse + context expand
$('messages').addEventListener('click', (e) => {
  const head = e.target.closest('.tool-head');
  if (head) { head.closest('.tool-card').classList.toggle('open'); return; }
  const ctx = e.target.closest('.msg.context');
  if (ctx) ctx.classList.toggle('open');
});

/* ---------------- boot ---------------- */
(async function boot() {
  setConn('connecting');
  try {
    await loadHost();
    await loadSessions();
    setConn('on');
    ensureMux();
    ensureHost();
    // auto-open first non-blank session
    const first = state.sessions.find((s) => !s.blank);
    if (first) await openSession(first.sessionId);
  } catch (e) {
    setConn('off');
    flashError(`无法连接 DSH: ${e.message}`);
  }
})();
