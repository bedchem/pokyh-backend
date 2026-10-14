// Pokyh updater — carries out updates on a server set up by the one-line
// installer, without downtime. The only part of the stack with access to
// Docker: it opens no port, and the app reaches it only through files in
// data/update (src/cluster/updates.ts decides *when* and *what*; this decides
// nothing on its own).
//
//   request.json   written by the app: a new version to switch to (the build
//                  the cluster handed over, checked by SHA-256, or a commit
//                  of the configured git repository), or back to the
//                  previous one;
//   status.json    written here: what is happening, what went wrong;
//   active         written here: the colour (blue/green) that is active.
//
// An update: build the image; start it as the other colour next to the
// running one (it serves HTTP but waits with background work and the cluster
// until it is named active); once it reports healthy, stop the old one
// gracefully and name the new one active. If the new one does not become
// healthy in time, it is removed and nothing else changes.
//
// The app's image may come from anything the app asks for — it runs with the
// same limits either way. What runs *outside* those limits — this updater
// (Docker access), the edge forwarder and the stack definition — is taken
// only from the repository and branch fixed in compose.env at install time
// (POKYH_RUNTIME_REPO/BRANCH; the app cannot write that file), fetched here
// and checked to be on that branch, never from a build the app hands over.
// A new compose.yml must also pass the policy below (no privileged
// containers, only the expected files mounted, the Docker socket for this
// updater only, no other published ports).

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = process.env.POKYH_HOME || '/opt/pokyh';
const UPDATE_DIR = path.join(HOME, 'data', 'update');
const POLL_MS = 3_000;
const BUILD_TIMEOUT_MS = 45 * 60 * 1000;
const KEEP_RELEASES = 2;
// After the new colour is healthy: time for Caddy's own health check to see
// it too, before the old one stops taking requests.
const SETTLE_MS = Number(process.env.POKYH_SWITCH_SETTLE_MS || 5_000);

const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

// ─── Policy for compose files shipped with an update ─────────────────────────

const ALLOWED_SERVICES = new Set(['mysql', 'redis', 'app-blue', 'app-green', 'edge', 'caddy', 'gateway', 'updater', 'ollama']);
// Host files each service may mount, relative to the installation directory.
const ALLOWED_BINDS = {
  mysql: ['.env'],
  'app-blue': ['data/bootstrap', 'data/update'],
  'app-green': ['data/bootstrap', 'data/update'],
  edge: ['runtime/edge.mjs'],
  caddy: ['Caddyfile'],
  gateway: ['Caddyfile'],
};
const ALLOWED_CAPS = {
  'app-blue': ['CHOWN', 'SETUID', 'SETGID'],
  'app-green': ['CHOWN', 'SETUID', 'SETGID'],
  caddy: ['NET_BIND_SERVICE'],
};
const PUBLISHED = { edge: [4100], caddy: [80, 443], gateway: [8080] };
const NO_NEW_PRIVILEGES = new Set(['app-blue', 'app-green', 'edge', 'caddy', 'gateway', 'redis', 'ollama', 'updater']);

// `config` is the output of `docker compose config --format json`. Returns
// the list of violations (empty: acceptable).
export function checkComposePolicy(config, home = HOME) {
  const problems = [];
  const root = path.resolve(home);
  const inside = (source) => {
    const resolved = path.resolve(source);
    return resolved === root || resolved.startsWith(`${root}${path.sep}`);
  };
  for (const [name, service] of Object.entries(config?.services ?? {})) {
    if (!ALLOWED_SERVICES.has(name)) { problems.push(`unknown service ${name}`); continue; }
    if (service.privileged) problems.push(`${name}: privileged`);
    for (const key of ['pid', 'ipc', 'userns_mode', 'uts', 'cgroup']) {
      if (service[key] === 'host') problems.push(`${name}: ${key}: host`);
    }
    if (service.network_mode && !(name === 'updater' && service.network_mode === 'bridge')) problems.push(`${name}: network_mode ${service.network_mode}`);
    if ((service.devices ?? []).length > 0) problems.push(`${name}: devices`);
    if ((service.cap_add ?? []).some((cap) => !(ALLOWED_CAPS[name] ?? []).includes(cap))) problems.push(`${name}: capabilities ${service.cap_add.join(',')}`);
    if (NO_NEW_PRIVILEGES.has(name) && !(service.security_opt ?? []).some((option) => /^no-new-privileges(:true)?$/.test(option))) {
      problems.push(`${name}: no-new-privileges missing`);
    }
    if (name === 'updater' && service.image !== 'pokyh-updater:local') problems.push('updater: unexpected image');
    for (const volume of service.volumes ?? []) {
      if (volume.type !== 'bind') continue;
      const socket = volume.source === '/var/run/docker.sock' || volume.source === '/run/docker.sock';
      if (name === 'updater') {
        if (!socket && path.resolve(volume.source) !== root) problems.push(`updater: host path ${volume.source}`);
        continue;
      }
      if (socket) { problems.push(`${name}: Docker socket`); continue; }
      const relative = inside(volume.source) ? path.relative(root, path.resolve(volume.source)) : null;
      if (relative === null || !(ALLOWED_BINDS[name] ?? []).includes(relative)) problems.push(`${name}: host path ${volume.source}`);
    }
    for (const port of service.ports ?? []) {
      const published = Number(port.published);
      if (!(PUBLISHED[name] ?? []).includes(Number(port.target))) problems.push(`${name}: publishes ${port.target}`);
      if (!Number.isInteger(published) || published < 1) problems.push(`${name}: publishes an unspecified host port`);
    }
  }
  return problems;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function run(file, args, { timeoutMs = 120_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, cwd }, (error, stdout, stderr) => {
      if (error) {
        const tail = `${stderr || stdout || error.message}`.trim().split('\n').slice(-6).join(' | ').slice(0, 600);
        reject(new Error(`${path.basename(file)} ${args[0] ?? ''} failed: ${tail}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

const compose = (args, options) => run('docker', ['compose', '--project-directory', HOME, '--env-file', path.join(HOME, 'compose.env'), '-f', path.join(HOME, 'compose.yml'), ...args], options);

function writeAtomic(file, text, mode = 0o644) {
  fs.writeFileSync(`${file}.tmp`, text, { mode });
  fs.renameSync(`${file}.tmp`, file);
}

export function readEnvFile(text) {
  const values = new Map();
  for (const line of text.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

// Sets keys in a KEY=value file, keeping everything else as it is.
export function updateEnvText(text, changes) {
  const lines = text.split('\n');
  const done = new Set();
  const out = lines.map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match && match[1] in changes) { done.add(match[1]); return `${match[1]}=${changes[match[1]]}`; }
    return line;
  });
  for (const [key, value] of Object.entries(changes)) if (!done.has(key)) out.splice(out.length - (out.at(-1) === '' ? 1 : 0), 0, `${key}=${value}`);
  return out.join('\n');
}

export function swapProfile(profiles, from, to) {
  const list = profiles.split(',').map((item) => item.trim()).filter(Boolean).filter((item) => item !== from && item !== to);
  return [to, ...list].join(',');
}

function status(fields) {
  writeAtomic(path.join(UPDATE_DIR, 'status.json'), `${JSON.stringify({ ...fields, at: new Date().toISOString() })}\n`);
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...fields })}\n`);
}

function activeColor() {
  try {
    const value = fs.readFileSync(path.join(UPDATE_DIR, 'active'), 'utf8').trim();
    return value === 'green' ? 'green' : 'blue';
  } catch {
    return 'blue';
  }
}

async function containerOf(service) {
  return (await compose(['ps', '-q', service])).trim().split('\n')[0] ?? '';
}

async function waitHealthy(service, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const id = await containerOf(service);
    if (id) {
      const state = (await run('docker', ['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.Status}}', id])).trim();
      const [health, running] = state.split('|');
      if (health === 'healthy') return;
      if (running === 'exited' || running === 'dead') throw new Error(`the new version stopped (${running})`);
    }
    if (Date.now() > deadline) throw new Error('the new version did not become healthy in time');
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

// ─── One update ──────────────────────────────────────────────────────────────

function validRequest(request) {
  if (!request || typeof request !== 'object' || typeof request.id !== 'string' || !/^[0-9a-f-]{36}$/.test(request.id)) return 'malformed request';
  if (request.source === 'rollback') return null;
  if (!COMMIT.test(request.commit ?? '')) return 'malformed commit';
  if (request.source === 'bundle') {
    if (!SHA256.test(request.sha256 ?? '')) return 'malformed hash';
    return null;
  }
  if (request.source === 'git') {
    try {
      const url = new URL(request.repo);
      if (url.protocol !== 'https:' || url.username || url.password) return 'the repository must be an https address';
    } catch {
      return 'the repository address is malformed';
    }
    return null;
  }
  return 'unknown source';
}

async function prepareRelease(request) {
  const release = path.join(HOME, 'releases', request.commit);
  fs.rmSync(release, { recursive: true, force: true });
  fs.mkdirSync(release, { recursive: true, mode: 0o755 });
  if (request.source === 'bundle') {
    const bundle = path.join(UPDATE_DIR, `bundle-${request.sha256}.tgz`);
    const hash = createHash('sha256').update(fs.readFileSync(bundle)).digest('hex');
    if (hash !== request.sha256) throw new Error('the build does not match its hash');
    await run('tar', ['-xzf', bundle, '-C', release, '--strip-components=1']);
    return { release, dockerfile: 'deploy/node/Dockerfile' };
  }
  await run('git', ['init', '-q', release]);
  await run('git', ['-C', release, 'fetch', '-q', '--depth', '1', request.repo, request.commit], { timeoutMs: 10 * 60_000 });
  await run('git', ['-C', release, 'checkout', '-q', 'FETCH_HEAD']);
  const head = (await run('git', ['-C', release, 'rev-parse', 'HEAD'])).trim();
  if (head !== request.commit) throw new Error('the repository returned a different commit');
  fs.rmSync(path.join(release, '.git'), { recursive: true, force: true });
  return { release, dockerfile: 'Dockerfile' };
}

// The runtime files of `commit`, from the trusted repository and branch
// only: fetched here, and used only if the commit is on that branch.
async function trustedRuntime(commit, values) {
  const repo = values.get('POKYH_RUNTIME_REPO') ?? '';
  const branch = values.get('POKYH_RUNTIME_BRANCH') || 'main';
  if (!repo) return { dir: null, note: 'runtime files unchanged (no trusted repository set at install)' };
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~-]+){2,4}$/.test(repo) || !/^[A-Za-z0-9._/-]{1,200}$/.test(branch) || branch.includes('..')) {
    return { dir: null, note: 'runtime files unchanged (the trusted repository setting is malformed)' };
  }
  const dir = path.join(HOME, 'releases', `runtime-${commit}`);
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    await run('git', ['init', '-q', dir]);
    await run('git', ['-C', dir, 'fetch', '-q', '--depth', '200', `${repo}.git`, `refs/heads/${branch}`], { timeoutMs: 10 * 60_000 });
    const onBranch = (await run('git', ['-C', dir, 'rev-list', 'FETCH_HEAD'])).split('\n').includes(commit);
    if (!onBranch) {
      fs.rmSync(dir, { recursive: true, force: true });
      return { dir: null, note: `runtime files unchanged (${commit.slice(0, 7)} is not on ${branch} of the trusted repository)` };
    }
    await run('git', ['-C', dir, 'checkout', '-q', commit]);
    return { dir, note: null };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { dir: null, note: `runtime files unchanged (${err.message.slice(0, 200)})` };
  }
}

// Applies the compose file and helper scripts of a trusted checkout, after
// the policy check; returns what has to be restarted and how to undo it.
async function applyRuntime(trusted) {
  const shipped = path.join(trusted, 'deploy', 'node');
  const current = path.join(HOME, 'compose.yml');
  const next = path.join(shipped, 'compose.yml');
  let composeChanged = false;
  if (fs.existsSync(next) && fs.readFileSync(next, 'utf8') !== fs.readFileSync(current, 'utf8')) {
    const rendered = JSON.parse(await run('docker', ['compose', '--project-directory', HOME, '--env-file', path.join(HOME, 'compose.env'), '-f', next, 'config', '--format', 'json']));
    const problems = checkComposePolicy(rendered);
    if (problems.length > 0) throw new Error(`the new compose.yml breaks the security policy: ${problems.slice(0, 5).join('; ')}`);
    fs.copyFileSync(current, `${current}.previous`);
    fs.copyFileSync(next, current);
    composeChanged = true;
  }
  let edgeChanged = false;
  let updaterChanged = false;
  let updaterImageChanged = false;
  const dockerfile = path.join(shipped, 'updater.Dockerfile');
  const installedDockerfile = path.join(HOME, 'runtime', 'updater.Dockerfile');
  if (fs.existsSync(dockerfile) && (!fs.existsSync(installedDockerfile) || fs.readFileSync(dockerfile, 'utf8') !== fs.readFileSync(installedDockerfile, 'utf8'))) {
    await run('docker', ['build', '-q', '-f', dockerfile, '-t', 'pokyh-updater:local', shipped], { timeoutMs: BUILD_TIMEOUT_MS });
    fs.copyFileSync(dockerfile, installedDockerfile);
    updaterImageChanged = true;
  }
  for (const file of ['edge.mjs', 'updater.mjs']) {
    const source = path.join(shipped, file);
    const target = path.join(HOME, 'runtime', file);
    if (fs.existsSync(source) && (!fs.existsSync(target) || fs.readFileSync(source, 'utf8') !== fs.readFileSync(target, 'utf8'))) {
      fs.copyFileSync(source, `${target}.tmp`);
      fs.renameSync(`${target}.tmp`, target);
      if (file === 'edge.mjs') edgeChanged = true; else updaterChanged = true;
    }
  }
  return { composeChanged, edgeChanged, updaterChanged, updaterImageChanged };
}

async function cleanup(keepTags) {
  const releases = path.join(HOME, 'releases');
  if (fs.existsSync(releases)) {
    const entries = fs.readdirSync(releases).map((name) => ({ name, at: fs.statSync(path.join(releases, name)).mtimeMs })).sort((a, b) => b.at - a.at);
    for (const entry of entries.slice(KEEP_RELEASES)) fs.rmSync(path.join(releases, entry.name), { recursive: true, force: true });
  }
  for (const file of fs.readdirSync(UPDATE_DIR)) {
    if (/^bundle-[0-9a-f]{64}\.tgz(\.part)?$/.test(file)) fs.rmSync(path.join(UPDATE_DIR, file), { force: true });
  }
  const tags = (await run('docker', ['images', 'pokyh-node', '--format', '{{.Tag}}'])).trim().split('\n').filter(Boolean);
  for (const tag of tags) if (!keepTags.includes(tag)) await run('docker', ['image', 'rm', `pokyh-node:${tag}`]).catch(() => {});
}

export async function carryOut(request, { healthTimeoutMs }) {
  const envFile = path.join(HOME, 'compose.env');
  const envBefore = fs.readFileSync(envFile, 'utf8');
  const values = readEnvFile(envBefore);
  const active = activeColor();
  const other = active === 'blue' ? 'green' : 'blue';
  const activeTag = values.get(`POKYH_IMAGE_${active.toUpperCase()}`) ?? '';
  const base = { id: request.id, commit: request.commit ?? null, source: request.source };

  let tag;
  let runtime = { composeChanged: false, edgeChanged: false, updaterChanged: false, updaterImageChanged: false };
  let note = null;
  if (request.source === 'rollback') {
    tag = values.get(`POKYH_IMAGE_${other.toUpperCase()}`) ?? '';
    if (!tag || tag === activeTag || tag === 'none') throw new Error('there is no previous version to go back to');
  } else {
    status({ ...base, state: 'preparing', message: 'Fetching the new version' });
    const prepared = await prepareRelease(request);
    tag = request.commit.slice(0, 12);
    status({ ...base, state: 'building', message: 'Building the new version' });
    await run('docker', ['build', '-q', '-f', prepared.dockerfile, '--build-arg', `POKYH_COMMIT=${request.commit}`, '-t', `pokyh-node:${tag}`, '.'], { cwd: prepared.release, timeoutMs: BUILD_TIMEOUT_MS });
    const trusted = await trustedRuntime(request.commit, values);
    note = trusted.note;
    if (trusted.dir) {
      runtime = await applyRuntime(trusted.dir);
      fs.rmSync(trusted.dir, { recursive: true, force: true });
    }
  }

  status({ ...base, state: 'starting', message: `Starting the new version as ${other}` });
  writeAtomic(envFile, updateEnvText(envBefore, { [`POKYH_IMAGE_${other.toUpperCase()}`]: tag }), 0o600);
  try {
    await compose(['up', '-d', '--no-deps', `app-${other}`], { timeoutMs: 10 * 60_000 });
    await waitHealthy(`app-${other}`, healthTimeoutMs);
  } catch (err) {
    const id = await containerOf(`app-${other}`).catch(() => '');
    const logs = id ? (await run('docker', ['logs', '--tail', '15', id]).catch(() => '')).trim().split('\n').slice(-5).join(' | ') : '';
    await compose(['rm', '-sf', `app-${other}`]).catch(() => {});
    writeAtomic(envFile, envBefore, 0o600);
    const composeFile = path.join(HOME, 'compose.yml');
    if (runtime.composeChanged && fs.existsSync(`${composeFile}.previous`)) fs.copyFileSync(`${composeFile}.previous`, composeFile);
    throw new Error(`${err.message}${logs ? ` — ${logs.slice(0, 400)}` : ''}`);
  }

  status({ ...base, state: 'switching', message: `Switching from ${active} to ${other}` });
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  // Requests in flight finish on the old one; new ones already reach the new one.
  await compose(['stop', '-t', '30', `app-${active}`], { timeoutMs: 120_000 });
  writeAtomic(path.join(UPDATE_DIR, 'active'), `${other}\n`);
  const after = fs.readFileSync(envFile, 'utf8');
  writeAtomic(envFile, updateEnvText(after, { COMPOSE_PROFILES: swapProfile(readEnvFile(after).get('COMPOSE_PROFILES') ?? '', active, other) }), 0o600);
  // The rest of the stack follows a changed definition (never the updater
  // itself here: it is replaced by a helper, below).
  if (runtime.composeChanged) {
    const byProfile = { web: 'caddy', gateway: 'gateway', ai: 'ollama' };
    const others = ['mysql', 'redis', 'edge', ...(readEnvFile(fs.readFileSync(envFile, 'utf8')).get('COMPOSE_PROFILES') ?? '').split(',').map((item) => byProfile[item.trim()]).filter(Boolean)];
    await compose(['up', '-d', '--no-deps', ...others], { timeoutMs: 10 * 60_000 }).catch((err) => { note = `stack: ${err.message.slice(0, 200)}`; });
  } else if (runtime.edgeChanged) {
    await compose(['up', '-d', '--force-recreate', '--no-deps', 'edge']).catch(() => {});
  }
  await cleanup([tag, activeTag]).catch(() => {});
  status({ ...base, state: 'done', message: `Running ${request.source === 'rollback' ? 'the previous version' : 'the new version'} as ${other}${note ? ` — ${note}` : ''}`, color: other });
  return runtime;
}

// Replaces this container by one of the new image: a short-lived helper does
// it, since a container cannot recreate itself.
async function recreateSelf() {
  await run('docker', [
    'run', '-d', '--rm', '--name', `pokyh-updater-helper-${Date.now()}`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${HOME}:${HOME}`,
    'pokyh-updater:local',
    'sh', '-c', `sleep 3 && docker compose --project-directory '${HOME}' --env-file '${HOME}/compose.env' -f '${HOME}/compose.yml' up -d --force-recreate --no-deps updater`,
  ]);
}

// An update this process was carrying out when it stopped: leave the active
// colour running and the other one gone, and report it.
async function recoverInterrupted() {
  const previous = readStatus();
  if (!previous || ['done', 'failed'].includes(previous.state)) return previous?.id ?? null;
  const active = activeColor();
  const other = active === 'blue' ? 'green' : 'blue';
  await compose(['up', '-d', '--no-deps', `app-${active}`]).catch(() => {});
  if (previous.state !== 'switching') await compose(['rm', '-sf', `app-${other}`]).catch(() => {});
  status({ id: previous.id, commit: previous.commit ?? null, source: previous.source, state: 'failed', message: 'the update was interrupted (the updater restarted); this node stays on its running version' });
  return previous.id;
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(path.join(UPDATE_DIR, 'status.json'), 'utf8'));
  } catch {
    return null;
  }
}

// ─── Main loop ───────────────────────────────────────────────────────────────

export async function main() {
  fs.mkdirSync(UPDATE_DIR, { recursive: true });
  const requestFile = path.join(UPDATE_DIR, 'request.json');
  let lastId = await recoverInterrupted();
  const beat = () => writeAtomic(path.join(UPDATE_DIR, 'updater.json'), `${JSON.stringify({ at: new Date().toISOString(), active: activeColor() })}\n`);
  beat();
  setInterval(beat, 10_000).unref();
  for (;;) {
    let request = null;
    try { request = JSON.parse(fs.readFileSync(requestFile, 'utf8')); } catch { request = null; }
    if (request && request.id !== lastId) {
      lastId = request.id;
      const problem = validRequest(request);
      if (problem) {
        status({ id: request.id, state: 'failed', message: problem });
      } else {
        try {
          const healthTimeoutMs = Math.max(30, Math.min(3600, Number(request.healthTimeoutSeconds) || 300)) * 1000;
          const runtime = await carryOut(request, { healthTimeoutMs });
          // A newer updater came with the release: restart into it.
          if (runtime.updaterImageChanged) {
            await recreateSelf();
            await new Promise((resolve) => setTimeout(resolve, 60_000));
          }
          if (runtime.updaterChanged) process.exit(0);
        } catch (err) {
          status({ id: request.id, commit: request.commit ?? null, source: request.source, state: 'failed', message: err.message.slice(0, 800) });
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`updater stopped: ${err.message}\n`);
    process.exit(1);
  });
}
