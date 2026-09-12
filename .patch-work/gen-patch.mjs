/**
 * Generate delete-session-patch.json using git's diff (reliable hunks) between
 * pristine tarball copies and the currently-modified npx-cache files.
 * Dev tool only — not shipped.
 *
 * Hunks are split by content markers: only hunks containing this feature's
 * markers are emitted (the npx cache may carry pre-existing installer changes,
 * e.g. web-bg's WEB_SETTINGS_NAMESPACES additions). Cross-verification:
 * applying kept hunks to the pristine file must equal reverse-applying the
 * excluded hunks to the live file.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = 'E:\\Agent projects\\Deepseek Harness\\dsh-client\\.patch-work';
const NPX = 'C:\\Users\\31259\\AppData\\Local\\npm-cache\\_npx\\1e7f6d9597241db0\\node_modules\\@deepseek-ai';

const TARGETS = [
  { rel: 'dsh-api-remotes/lib/index.js', markers: ['disposeAgent', 'handles.set', 'Live resume handles'] },
  { rel: 'dsh-host-apiproxy/lib/index.js', markers: ['sessionRemoveValueSchema', 'disposeLiveAgent', 'sessionRemoveRequestSchema', 'removePersistedSession', 'agentHandles', 'unlink, rmdir', 'agentFor, disposeAgent', 'createdHandle', 'forkHandle', 'session.remove'] },
  { rel: 'dsh-client-runtime/lib/client.js', markers: ['removeSession'] },
  { rel: 'dsh-client-connection/lib/client.js', markers: ['sessionRemoveValueSchema', 'session.remove'] },
  { rel: 'dsh-client-ui-workspace/lib/client.js', markers: ['delete.session', 'onSessionDelete', 'sessionDeleteTarget', 'onDelete', 'deleteSession'] },
];

const count = (text, needle) => {
  if (needle === '') return 0;
  let n = 0, idx = 0;
  while ((idx = text.indexOf(needle, idx)) !== -1) { n++; idx += needle.length; }
  return n;
};

/** Parse `git diff --no-index --unified=3` output into hunks. */
function parseUnifiedDiff(output) {
  const hunks = [];
  let cur = null;
  let oldStart = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('@@')) {
      if (cur !== null) hunks.push(cur);
      const m = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      oldStart = m ? Number(m[1]) : 0;
      cur = { oldStart, rows: [] };
    } else if (cur !== null) {
      if (line.startsWith(' ')) cur.rows.push({ k: 'ctx', t: line.slice(1) });
      else if (line.startsWith('-')) cur.rows.push({ k: 'del', t: line.slice(1) });
      else if (line.startsWith('+')) cur.rows.push({ k: 'ins', t: line.slice(1) });
      // '\ No newline at end of file' and other trailers are ignored
    }
  }
  if (cur !== null) hunks.push(cur);
  return hunks;
}

/** Build anchored old/new pair for one diff hunk. */
function pairFor(h, origLines, curLines, origText) {
  // Walk the diff rows IN ORDER: context lines belong to both sides at their
  // position, deletions only to old, insertions only to new.
  const oldLines = [];
  const newLines = [];
  let firstOld = h.oldStart - 1; // old-file index of the hunk's first line
  for (const row of h.rows) {
    if (row.k === 'ctx') {
      oldLines.push(row.t);
      newLines.push(row.t);
    } else if (row.k === 'del') oldLines.push(row.t);
    else newLines.push(row.t);
  }
  // trim shared prefix (context appears on both sides)
  let trimmed = 0;
  while (oldLines.length > 0 && newLines.length > 0 && oldLines[0] === newLines[0]) {
    oldLines.shift();
    newLines.shift();
    trimmed++;
  }
  firstOld += trimmed;
  // trim shared suffix, but never empty `old` (a pure insertion keeps its
  // first following line as the anchor; a pure deletion keeps its deletions)
  while (oldLines.length > 1 && newLines.length > 1 && oldLines[oldLines.length - 1] === newLines[newLines.length - 1]) {
    oldLines.pop();
    newLines.pop();
  }
  // widen by prepending lines before the hunk until old is unique
  let guard = 0;
  while (count(origText, oldLines.join('\n')) !== 1 && guard++ < 5000) {
    if (firstOld > 0) {
      firstOld--;
      const o = origLines[firstOld];
      // the line before the hunk is identical in both files (unchanged region)
      oldLines.unshift(o);
      newLines.unshift(o);
    } else break;
  }
  const old = oldLines.join('\n');
  if (count(origText, old) !== 1) throw new Error(`hunk at old line ${h.oldStart} not uniquely anchored`);
  return { old, new: newLines.join('\n') };
}

const targets = [];
const excludedTargets = [];
for (const { rel, markers } of TARGETS) {
  const [pkg, ...rest] = rel.split('/');
  const fileRel = rest.join('/');
  const origPath = join(ROOT, 'orig', pkg, fileRel);
  const livePath = join(NPX, pkg, fileRel);
  const origText = readFileSync(origPath, 'utf8');
  const liveText = readFileSync(livePath, 'utf8');
  const origLines = origText.split('\n');
  const liveLines = liveText.split('\n');

  let diffOut;
  try {
    diffOut = execFileSync('git', ['diff', '--no-index', '--unified=3', '--', origPath, livePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    // git diff exits 1 when the files differ (the normal case here); stderr
    // carries only the LF/CRLF warnings
    diffOut = error.stdout ?? '';
  }
  const raw = parseUnifiedDiff(diffOut);
  const anchored = raw.map((h) => ({ ...pairFor(h, origLines, liveLines, origText), oldStart: h.oldStart }));
  // Cluster hunks that sit close together: an edit split across several git
  // hunks forms one cluster, classified MINE if ANY member carries a marker.
  // The web-bg installer change sits far from every edit of this feature.
  const CLUSTER_GAP = 16;
  const clusters = [];
  for (const p of anchored) {
    const last = clusters[clusters.length - 1];
    if (last !== void 0 && p.oldStart - last.end <= CLUSTER_GAP) last.members.push(p);
    else clusters.push({ start: p.oldStart, end: p.oldStart, members: [p] });
    clusters[clusters.length - 1].end = Math.max(clusters[clusters.length - 1].end, p.oldStart);
  }
  const kept = [], excluded = [];
  for (const cluster of clusters) {
    const isMine = markers.some((m) => cluster.members.some((p) => p.new.includes(m)));
    for (const p of cluster.members) (isMine ? kept : excluded).push(p);
  }

  // Cross-verify: pristine + kept === live − excluded
  let x = origText;
  for (const p of kept) {
    if (count(x, p.old) !== 1) throw new Error(`[${rel}] kept: old not unique at apply time`);
    x = x.replace(p.old, p.new);
  }
  let y = liveText;
  for (const p of excluded) {
    if (count(y, p.new) !== 1) throw new Error(`[${rel}] excluded: new not unique at reverse-apply time (${JSON.stringify(p.new.slice(0, 80))})`);
    y = y.replace(p.new, p.old);
  }
  if (x !== y) {
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i++;
    throw new Error(`[${rel}] cross-verify mismatch at ${i}\nX: ${JSON.stringify(x.slice(i, i + 120))}\nY: ${JSON.stringify(y.slice(i, i + 120))}`);
  }

  // per-patch idempotency marker: each `new` exists exactly once in the live file
  for (const p of kept) if (count(liveText, p.new) !== 1) throw new Error(`[${rel}] new not unique in live`);

  targets.push({ pkg, rel: fileRel, patches: kept });
  excludedTargets.push({ pkg, rel: fileRel, patches: excluded });
  console.log(`[ok] ${rel}: kept=${kept.length} excluded=${excluded.length} (cross-verified)`);
}

const out = {
  version: 1,
  description: 'Add "Delete session" (删除会话) to the sidebar session menu: session.remove RPC, client runtime remove(), connection API method, workspace UI menu item + confirm dialog. Applied by dsh-client before spawning the DSH host.',
  targets,
};
mkdirSync(join(ROOT, 'out'), { recursive: true });
const outPath = join(ROOT, 'out', 'delete-session-patch.json');
writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
console.log('wrote', outPath, `(${(await import('node:fs')).statSync(outPath).size} bytes)`);
// test-only sidecar: the hunks EXCLUDED as pre-existing installer changes
writeFileSync(join(ROOT, 'out', 'excluded-hunks.json'), JSON.stringify({ targets: excludedTargets }, null, 2), 'utf8');
console.log('wrote excluded-hunks.json (test sidecar)');
