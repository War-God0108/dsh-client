/**
 * test-patch.mjs — end-to-end verification of patch-delete-session.mjs:
 *
 * 1. Fresh-install simulation: patch pristine copies -> result must contain
 *    the feature markers and be node --check clean.
 * 2. Equivalence: patched pristine + excluded installer hunks must equal the
 *    live (already-patched) npx files byte-for-byte.
 * 3. Idempotency: re-running the applier on the patched copy and on the live
 *    files must be a no-op.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { applyToRoot } from '../electron/patch-delete-session.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ORIG = join(ROOT, 'orig');
const NPX = 'C:\\Users\\31259\\AppData\\Local\\npm-cache\\_npx\\1e7f6d9597241db0\\node_modules';
const TMP = join(ROOT, 'tmp-root');

const RELS = [
  'dsh-api-remotes/lib/index.js',
  'dsh-host-apiproxy/lib/index.js',
  'dsh-client-runtime/lib/client.js',
  'dsh-client-connection/lib/client.js',
  'dsh-client-ui-workspace/lib/client.js',
];
const MARKERS = {
  'dsh-api-remotes/lib/index.js': ['disposeAgent', 'handles.set'],
  'dsh-host-apiproxy/lib/index.js': ['sessionRemoveValueSchema', 'disposeLiveAgent', 'removePersistedSession'],
  'dsh-client-runtime/lib/client.js': ['removeSession'],
  'dsh-client-connection/lib/client.js': ['sessionRemoveValueSchema'],
  'dsh-client-ui-workspace/lib/client.js': ['delete.session', 'onSessionDelete'],
};

// build a pristine root at TMP (node_modules/@deepseek-ai/<pkg>/<rel>)
rmSync(TMP, { recursive: true, force: true });
for (const rel of RELS) {
  const [pkg, ...rest] = rel.split('/');
  const dest = join(TMP, '@deepseek-ai', pkg, rest.join('/'));
  mkdirSync(join(dest, '..'), { recursive: true });
  copyFileSync(join(ORIG, pkg, rest.join('/')), dest);
}
console.log('== step 1: apply patch to pristine copies ==');
const r1 = applyToRoot(TMP);
console.log('patched:', r1.changed, 'up-to-date:', r1.skipped, 'failed:', r1.failed);
if (r1.changed !== 5 || r1.failed !== 0) throw new Error('step 1: expected 5 patched, 0 failed');

console.log('== step 2: markers + syntax on patched copies ==');
for (const rel of RELS) {
  const [pkg, ...rest] = rel.split('/');
  const text = readFileSync(join(TMP, '@deepseek-ai', pkg, rest.join('/')), 'utf8');
  for (const m of MARKERS[rel]) if (!text.includes(m)) throw new Error(`step 2: ${rel} missing marker ${m}`);
  execFileSync('node', ['--check', join(TMP, '@deepseek-ai', pkg, rest.join('/'))]);
  console.log('  ok', rel);
}

console.log('== step 3: patched pristine + excluded(forward) == live ==');
const excluded = JSON.parse(readFileSync(join(ROOT, 'out', 'excluded-hunks.json'), 'utf8'));
for (const target of excluded.targets) {
  const path = join(TMP, '@deepseek-ai', target.pkg, target.rel);
  let text = readFileSync(path, 'utf8');
  for (const p of target.patches) {
    const n = text.split(p.old).length - 1;
    if (n !== 1) throw new Error(`step 3: excluded hunk ${target.pkg}/${target.rel} old not unique (${n})`);
    text = text.replace(p.old, p.new);
  }
  const live = readFileSync(join(NPX, '@deepseek-ai', target.pkg, target.rel), 'utf8');
  if (text !== live) throw new Error(`step 3: ${target.pkg}/${target.rel} mismatch`);
  console.log('  ok', target.pkg + '/' + target.rel);
}

console.log('== step 4: idempotency (re-run on patched copy and live) ==');
const r2 = applyToRoot(TMP);
if (r2.changed !== 0 || r2.failed !== 0) throw new Error('step 4: re-run on patched copy changed something');
const r3 = applyToRoot(NPX);
if (r3.changed !== 0 || r3.failed !== 0) throw new Error('step 4: re-run on live changed something');
console.log('  ok both no-op');

console.log('ALL TESTS PASSED');
