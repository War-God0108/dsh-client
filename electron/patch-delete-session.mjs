/**
 * patch-delete-session.mjs — idempotently apply the "Delete session"
 * (删除会话) feature patch to the DSH packages inside the npm npx cache.
 *
 * The DSH host is installed by `npx -y @deepseek-ai/dsh`, which keeps its
 * packages under %LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules. Any
 * reinstall or cache clean resets those files, so this script re-applies the
 * patch before the host is spawned. Safe to run any number of times: a file
 * that already carries a patch's replacement text is left untouched.
 *
 * Only two things are patched, because everything else lives in the
 * dsh-session-delete plugin:
 *   - @deepseek-ai/dsh-api-session-controller — retain the AgentHandle and expose
 *     disposeAgent(), the sole teardown path for a live Agent.
 *   - @deepseek-ai/dsh-client-ui-workspace — the sidebar session menu item and
 *     its confirmation dialog.
 *
 * Usage:
 *   node patch-delete-session.mjs                 # patch every npx-cache root
 *   node patch-delete-session.mjs <root>          # patch one explicit root
 *
 * Exit code 0 = all targets patched or already patched;
 * exit code 1 = a target could not be located or a patch did not match.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const PATCH_FILE = join(SELF_DIR, 'delete-session-patch.json');

const count = (text, needle) => {
  if (needle === '') return 0;
  let n = 0, idx = 0;
  while ((idx = text.indexOf(needle, idx)) !== -1) { n++; idx += needle.length; }
  return n;
};

/** All candidate npx-cache roots that actually contain the DSH packages. */
function npxRoots() {
  const cache = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local');
  const npxDir = join(cache, 'npm-cache', '_npx');
  const roots = [];
  let entries = [];
  try { entries = readdirSync(npxDir); } catch { return roots; }
  for (const entry of entries) {
    const root = join(npxDir, entry, 'node_modules');
    /* Probe the CLI package itself: it exists in every DSH release, unlike any
       individual feature package (0.1.5 renamed/split several of them). */
    if (existsSync(join(root, '@deepseek-ai', 'dsh', 'package.json'))) roots.push(root);
  }
  return roots;
}

/** Apply the patch to one package root (its `node_modules` directory). */
function applyToRoot(root) {
  const patch = JSON.parse(readFileSync(PATCH_FILE, 'utf8'));
  let changed = 0;
  let skipped = 0;
  let failed = 0;
  for (const target of patch.targets) {
    const path = join(root, '@deepseek-ai', target.pkg, target.rel);
    let text;
    try { text = readFileSync(path, 'utf8'); } catch { failed++; console.error(`  MISSING ${target.pkg}/${target.rel}`); continue; }
    let fileChanged = false;
    for (const p of target.patches) {
      if (text.includes(p.new)) { skipped++; continue; }
      const n = count(text, p.old);
      if (n !== 1) {
        failed++;
        console.error(`  MISMATCH ${target.pkg}/${target.rel}: expected exactly 1 occurrence of patch anchor, found ${n} — the package version may have changed`);
        break;
      }
      text = text.replace(p.old, p.new);
      fileChanged = true;
    }
    if (fileChanged) {
      writeFileSync(path, text, 'utf8');
      changed++;
      console.log(`  patched ${target.pkg}/${target.rel}`);
    } else if (!failed) {
      skipped++;
      console.log(`  up-to-date ${target.pkg}/${target.rel}`);
    }
  }
  return { changed, skipped, failed };
}

function main() {
  const explicit = process.argv[2];
  let roots = explicit ? [explicit] : npxRoots();
  if (roots.length === 0) {
    console.error('delete-session patch: no DSH package root found (npm npx cache missing?)');
    process.exit(1);
  }
  for (const root of roots) {
    console.log(`delete-session patch: applying under ${root}`);
    const { changed, skipped, failed } = applyToRoot(root);
    console.log(`  result: ${changed} file(s) patched, ${skipped} up-to-date, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  }
  if (process.exitCode === undefined) {
    console.log('delete-session patch: done');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export { applyToRoot, npxRoots };
