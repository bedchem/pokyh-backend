import { Router, Request, Response } from 'express';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { requireAdmin } from '../middleware/requireAdmin';
import { isCloudflaredInstalled, hasCloudflareAuth, isTunnelConfigured, startTunnel, installCloudflared } from '../tunnel';

const router = Router();

const ENV_PATH = path.join(__dirname, '..', '..', '.env');

function updateEnvFile(key: string, value: string): void {
  let content = '';
  try { content = fs.readFileSync(ENV_PATH, 'utf-8'); } catch { content = ''; }
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=`, 'm').test(content)) {
    content = content.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  } else {
    content = content.trimEnd() + '\n' + line + '\n';
  }
  fs.writeFileSync(ENV_PATH, content, 'utf-8');
}

// ─── GET /api/setup/status ────────────────────────────────────────────────────

router.get('/status', (_req: Request, res: Response): void => {
  res.json({
    needsSetup: !config.adminPasswordHash,
    cloudflaredInstalled: isCloudflaredInstalled(),
    cloudflareAuthed: hasCloudflareAuth(),
    tunnelConfigured: isTunnelConfigured(),
    tunnelHostname: config.tunnelHostname || null,
  });
});

// ─── POST /api/setup/password ─────────────────────────────────────────────────

router.post('/password', async (req: Request, res: Response): Promise<void> => {
  if (config.adminPasswordHash) {
    res.status(403).json({ error: 'Admin password already configured. Use the admin panel to change it.' });
    return;
  }

  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password required' });
    return;
  }
  if (username.length < 3) {
    res.status(400).json({ error: 'Username must be at least 3 characters' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  updateEnvFile('ADMIN_USERNAME', username);
  updateEnvFile('ADMIN_PASSWORD_HASH', hash);

  // Update runtime config so login works immediately
  config.adminUsername = username;
  config.adminPasswordHash = hash;

  // Auto-issue admin JWT so the setup can continue without re-login
  config.adminUsernames = [username, ...config.adminUsernames.filter((u) => u !== username)];
  const token = jwt.sign({ role: 'admin', sub: 'admin-panel', username }, config.jwtSecret, { expiresIn: '8h' });

  res.json({ ok: true, token });
});

// ─── GET /api/setup/cloudflare/login-stream ───────────────────────────────────
// SSE: starts `cloudflared tunnel login` and streams output

router.get('/cloudflare/login-stream', requireAdmin, (req: Request, res: Response): void => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  async function run() {
    if (!isCloudflaredInstalled()) {
      send({ type: 'log', message: 'cloudflared not found — downloading latest version automatically...' });
      try {
        await installCloudflared((msg) => send({ type: 'log', message: msg }));
      } catch (e) {
        send({ type: 'error', message: `Auto-install failed: ${(e as Error).message}\n\nInstall manually:\n  brew install cloudflare/cloudflare/cloudflared` });
        res.end();
        return;
      }
    }

    if (hasCloudflareAuth()) {
      send({ type: 'done', message: 'Already authenticated with Cloudflare ✓' });
      res.end();
      return;
    }

    send({ type: 'log', message: 'Starting Cloudflare authentication...' });
    send({ type: 'log', message: 'A browser window will open — log in and click Authorize.' });

    const proc = spawn('cloudflared', ['tunnel', 'login'], { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', (d: Buffer) => {
      const text = d.toString().trim();
      if (text) send({ type: 'log', message: text });
    });
    proc.stderr.on('data', (d: Buffer) => {
      const text = d.toString().trim();
      if (text) send({ type: 'log', message: text });
    });
    proc.on('close', (code) => {
      if (code === 0 || hasCloudflareAuth()) {
        send({ type: 'done', message: 'Successfully authenticated with Cloudflare ✓' });
      } else {
        send({ type: 'error', message: `Authentication failed (exit code ${code})` });
      }
      res.end();
    });
    proc.on('error', (err) => {
      send({ type: 'error', message: `Failed to run cloudflared: ${err.message}` });
      res.end();
    });

    req.on('close', () => proc.kill());
  }

  run().catch((e) => {
    send({ type: 'error', message: String(e) });
    res.end();
  });
});

// ─── GET /api/setup/cloudflare/tunnel-stream ──────────────────────────────────
// SSE: creates tunnel, configures DNS, writes config, starts tunnel

router.get('/cloudflare/tunnel-stream', requireAdmin, (req: Request, res: Response): void => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const hostname = typeof req.query['hostname'] === 'string' ? req.query['hostname'] : 'api.pokyh.com';
  const tunnelName = 'pokyh-api';

  async function run() {
    send({ type: 'log', message: `Setting up tunnel '${tunnelName}' → ${hostname}` });

    if (!hasCloudflareAuth()) {
      send({ type: 'error', message: 'Not authenticated with Cloudflare. Complete the login step first.' });
      res.end();
      return;
    }

    // Check / create tunnel
    let tunnelId = '';
    try {
      const listOut = execSync('cloudflared tunnel list 2>&1', { encoding: 'utf-8' });
      const lines = listOut.split('\n').filter(l => l.includes(tunnelName));
      if (lines.length > 0) {
        const match = lines[0]!.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (match) tunnelId = match[1]!;
        send({ type: 'log', message: `Found existing tunnel: ${tunnelId}` });
      }
    } catch { /* ignore */ }

    if (!tunnelId) {
      send({ type: 'log', message: `Creating tunnel '${tunnelName}'...` });
      try {
        const out = execSync(`cloudflared tunnel create ${tunnelName} 2>&1`, { encoding: 'utf-8' });
        const match = out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (match) tunnelId = match[1]!;
        send({ type: 'log', message: `Created tunnel: ${tunnelId}` });
      } catch (e) {
        send({ type: 'error', message: `Failed to create tunnel: ${(e as Error).message}` });
        res.end();
        return;
      }
    }

    // Write cloudflared config
    send({ type: 'log', message: 'Writing ~/.cloudflared/config.yml...' });
    const cfDir = path.join(os.homedir(), '.cloudflared');
    const cfConfig = [
      `tunnel: ${tunnelId}`,
      `credentials-file: ${cfDir}/${tunnelId}.json`,
      '',
      'ingress:',
      `  - hostname: ${hostname}`,
      `    service: http://localhost:${config.port}`,
      '  - service: http_status:404',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(cfDir, 'config.yml'), cfConfig, 'utf-8');
    send({ type: 'log', message: 'Config written ✓' });

    // Route DNS
    send({ type: 'log', message: `Routing DNS: ${hostname} → tunnel...` });
    try {
      execSync(`cloudflared tunnel route dns ${tunnelName} ${hostname} 2>&1`, { encoding: 'utf-8' });
      send({ type: 'log', message: 'DNS route configured ✓' });
    } catch (e) {
      send({ type: 'log', message: `DNS: ${(e as Error).message.split('\n')[0]} (may already exist — OK)` });
    }

    // Save to .env
    updateEnvFile('TUNNEL_NAME', tunnelName);
    updateEnvFile('TUNNEL_HOSTNAME', hostname);
    config.tunnelName = tunnelName;
    config.tunnelHostname = hostname;

    send({ type: 'log', message: 'Starting tunnel process...' });
    startTunnel(tunnelName);

    send({
      type: 'done',
      message: `Tunnel is running!\nYour API is now live at: https://${hostname}\nAdmin panel: https://${hostname}/admin/`,
    });
    res.end();
  }

  run().catch((e) => {
    send({ type: 'error', message: String(e) });
    res.end();
  });
});

export { router as setupRouter };
