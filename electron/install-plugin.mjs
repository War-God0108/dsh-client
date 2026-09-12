/**
 * install-plugin.mjs — deploy the dsh-session-delete Host plugin into the DSH
 * profile and make sure the profile composition mounts it.
 *
 * Two idempotent steps:
 *   1. copy plugin/dsh-session-delete into <DSH_HOME>/profiles/node_modules/
 *   2. append the loader insert entry to every <DSH_HOME>/profiles/<name>/cordis.patch.yml
 *      that does not already mount `dsh-session-delete`
 *
 * Exported so the desktop shell can run the same deployment before it spawns
 * the host; also runnable directly:
 *
 *   node install-plugin.mjs [--dsh-home <dir>] [--quiet]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_NAME = 'dsh-session-delete';
const SOURCE = join(SELF_DIR, 'plugin', PLUGIN_NAME);
const MARKER = `name: '${PLUGIN_NAME}'`;

/**
 * Copy a directory tree with explicit reads and writes.
 * Deliberately avoids `cpSync`: inside a packaged Electron app the source sits
 * in an asar archive, where only the plain fs primitives are guaranteed.
 * @param source - directory to read.
 * @param target - directory to (re)create.
 * @returns the number of files written.
 */
function copyTree(source, target) {
  mkdirSync(target, { recursive: true });
  let written = 0;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) written += copyTree(from, to);
    else {
      writeFileSync(to, readFileSync(from));
      written++;
    }
  }
  return written;
}

/** Default DSH home: `$DSH_HOME`, else `~/.dsh`. */
function defaultHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/**
 * Deploy the plugin package and mount it in every profile composition.
 * @param options - `dshHome` override and a `log` sink.
 * @returns a per-step report.
 */
export function installPlugin(options = {}) {
  const dshHome = options.dshHome ?? defaultHome();
  const log = options.log ?? (() => {});
  const report = { deployed: false, mounted: [], alreadyMounted: [], errors: [] };

  if (!existsSync(SOURCE)) {
    report.errors.push(`plugin source missing at ${SOURCE}`);
    return report;
  }

  const profilesDir = join(dshHome, 'profiles');
  const modulesDir = join(profilesDir, 'node_modules');
  const target = join(modulesDir, PLUGIN_NAME);
  try {
    mkdirSync(modulesDir, { recursive: true });
    /* Replace wholesale so a stale file from an older release cannot linger. */
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    const written = copyTree(SOURCE, target);
    report.deployed = true;
    log(`session-delete plugin deployed -> ${target} (${written} file(s))`);
  } catch (error) {
    report.errors.push(`deploy failed: ${error?.message ?? error}`);
    return report;
  }

  if (!existsSync(profilesDir)) {
    report.errors.push(`no DSH profiles directory at ${profilesDir}`);
    return report;
  }
  const profiles = readdirSync(profilesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(profilesDir, entry.name))
    .filter((dir) => existsSync(join(dir, 'cordis.patch.yml')));

  if (profiles.length === 0) {
    report.errors.push(`no cordis.patch.yml found under ${profilesDir}`);
    return report;
  }

  const entry = [
    `# ${PLUGIN_NAME}: 删除会话插件（由 install.cmd 写入，删除该条目即可卸载）`,
    '- insert:',
    '    - id: session-delete',
    `      name: '${PLUGIN_NAME}'`,
    '',
  ].join('\n');

  for (const profile of profiles) {
    const file = join(profile, 'cordis.patch.yml');
    try {
      const text = readFileSync(file, 'utf8');
      if (text.includes(MARKER)) {
        report.alreadyMounted.push(file);
        log(`session-delete plugin already mounted in ${file}`);
        continue;
      }
      const separator = text.endsWith('\n') ? '\n' : '\n\n';
      writeFileSync(file, `${text}${separator}${entry}`, 'utf8');
      report.mounted.push(file);
      log(`session-delete plugin mounted in ${file}`);
    } catch (error) {
      report.errors.push(`mount failed for ${file}: ${error?.message ?? error}`);
    }
  }
  return report;
}

if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  const homeFlag = args.indexOf('--dsh-home');
  const dshHome = homeFlag === -1 ? undefined : args[homeFlag + 1];
  const report = installPlugin({ dshHome, log: quiet ? () => {} : (message) => console.log(`install-plugin: ${message}`) });
  for (const error of report.errors) console.error(`install-plugin: ${error}`);
  if (report.errors.length > 0) process.exit(1);
  if (!quiet) console.log('install-plugin: done — restart DSH for the plugin to load');
}
