import { spawn, execSync, ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

let tunnelProcess: ChildProcess | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let currentTunnelName = '';

export function isTunnelConfigured(): boolean {
  return fs.existsSync(path.join(os.homedir(), '.cloudflared', 'config.yml'));
}

export function isCloudflaredInstalled(): boolean {
  try {
    execSync('cloudflared --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function hasCloudflareAuth(): boolean {
  return fs.existsSync(path.join(os.homedir(), '.cloudflared', 'cert.pem'));
}

export function getTunnelStatus(): 'running' | 'stopped' | 'not-configured' {
  if (!isTunnelConfigured()) return 'not-configured';
  if (tunnelProcess && !tunnelProcess.killed) return 'running';
  return 'stopped';
}

export function getTunnelNameFromConfig(): string | null {
  try {
    const cfg = path.join(os.homedir(), '.cloudflared', 'config.yml');
    const content = fs.readFileSync(cfg, 'utf8');
    const match = content.match(/^tunnel:\s*(.+)$/m);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export function getHostnameFromCloudflaredConfig(): string | null {
  try {
    const cfg = path.join(os.homedir(), '.cloudflared', 'config.yml');
    const content = fs.readFileSync(cfg, 'utf8');
    const match = content.match(/^\s*-\s+hostname:\s+(.+)$/m);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export function startTunnel(name?: string): void {
  if (name) currentTunnelName = name;
  // If no name provided, try to read from config.yml (persists across restarts)
  if (!currentTunnelName) {
    currentTunnelName = getTunnelNameFromConfig() ?? '';
  }
  if (!currentTunnelName || !isTunnelConfigured()) return;
  if (tunnelProcess && !tunnelProcess.killed) return;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }

  console.log(`[tunnel] Starting cloudflared tunnel '${currentTunnelName}'...`);

  tunnelProcess = spawn('cloudflared', ['tunnel', 'run', currentTunnelName], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  tunnelProcess.stdout?.on('data', (d: Buffer) => {
    d.toString().split('\n').filter(Boolean).forEach(l => console.log(`[tunnel] ${l}`));
  });
  tunnelProcess.stderr?.on('data', (d: Buffer) => {
    d.toString().split('\n').filter(Boolean).forEach(l => console.log(`[tunnel] ${l}`));
  });

  tunnelProcess.on('close', (code) => {
    console.log(`[tunnel] Exited (code ${code}). Restarting in 5s...`);
    tunnelProcess = null;
    restartTimer = setTimeout(() => startTunnel(), 5000);
  });

  tunnelProcess.on('error', (err) => {
    console.error('[tunnel] Failed to start:', err.message);
    tunnelProcess = null;
    restartTimer = setTimeout(() => startTunnel(), 10000);
  });
}

// ─── Auto-install cloudflared ─────────────────────────────────────────────────

function getCloudflaredDownloadUrl(): string {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'darwin') {
    return arch === 'arm64'
      ? 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz'
      : 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz';
  }
  if (platform === 'linux') {
    if (arch === 'arm64' || arch === 'aarch64') {
      return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64';
    }
    if (arch === 'arm') {
      return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm';
    }
    return 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64';
  }
  throw new Error(`Unsupported platform: ${platform}/${arch}. Install cloudflared manually from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/`);
}

function httpsGet(url: string): Promise<import('http').IncomingMessage> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'pokyh-backend/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        resolve(httpsGet(res.headers.location!));
      } else {
        resolve(res);
      }
    }).on('error', reject);
  });
}

export async function installCloudflared(log: (msg: string) => void): Promise<void> {
  const installDir = path.join(os.homedir(), '.local', 'bin');
  const installPath = path.join(installDir, 'cloudflared');

  fs.mkdirSync(installDir, { recursive: true });

  const url = getCloudflaredDownloadUrl();
  const isTarball = url.endsWith('.tgz');

  log(`Downloading cloudflared from GitHub releases...`);
  log(`Platform: ${os.platform()}/${os.arch()}`);

  const tmpPath = path.join(os.tmpdir(), isTarball ? 'cloudflared.tgz' : 'cloudflared-bin');

  const res = await httpsGet(url);
  if (!res.statusCode || res.statusCode >= 400) {
    throw new Error(`Download failed: HTTP ${res.statusCode}`);
  }

  await pipeline(res, createWriteStream(tmpPath));
  log(`Download complete.`);

  if (isTarball) {
    log(`Extracting...`);
    execSync(`tar -xzf ${tmpPath} -C ${os.tmpdir()} cloudflared`, { stdio: 'ignore' });
    fs.renameSync(path.join(os.tmpdir(), 'cloudflared'), installPath);
    fs.unlinkSync(tmpPath);
  } else {
    fs.renameSync(tmpPath, installPath);
  }

  fs.chmodSync(installPath, 0o755);
  log(`cloudflared installed to ${installPath}`);

  // Add to PATH for this process
  process.env['PATH'] = `${installDir}:${process.env['PATH'] ?? ''}`;

  // Verify
  const version = execSync('cloudflared --version', { encoding: 'utf-8' }).trim();
  log(`Installed: ${version}`);
}

export function stopTunnel(): void {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (tunnelProcess && !tunnelProcess.killed) {
    tunnelProcess.kill('SIGTERM');
    tunnelProcess = null;
  }
}
