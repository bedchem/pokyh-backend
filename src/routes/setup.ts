import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../db';
import { authLimiter } from '../middleware/rateLimiter';

const router = Router();
const ENV_PATH = path.join(__dirname, '..', '..', '.env');

const USERNAME = /^[A-Za-z0-9._-]{3,64}$/;
const MAX_PASSWORD_LENGTH = 256;

// A value written here must stay one line: a line break would let the caller
// add settings of its own to the env file (and through them reach every
// process the server starts).
function updateEnvFile(key: string, value: string): void {
  if (/[\r\n\0]/.test(value)) throw new Error('Refusing to write a multi-line value to the env file');
  let content = '';
  try { content = fs.readFileSync(ENV_PATH, 'utf-8'); } catch { content = ''; }
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=`, 'm').test(content)) {
    // A function, so `$` sequences in the value (every bcrypt hash has them)
    // are never read as replacement patterns.
    content = content.replace(new RegExp(`^${key}=.*$`, 'm'), () => line);
  } else {
    content = content.trimEnd() + '\n' + line + '\n';
  }
  fs.writeFileSync(ENV_PATH, content, { encoding: 'utf-8', mode: 0o600 });
}

// The setup is the way in for a server that has no administrator at all, and
// it is reachable without any credentials. It is therefore closed as soon as
// any administrator can sign in — from the env file or from the database
// (npm run make-admin) — and on every cluster node, which receives its
// administrators from the cluster. When the database cannot be asked, it is
// closed too.
async function setupOpen(): Promise<boolean> {
  if (config.adminPasswordHash || config.cluster.bootstrapDir) return false;
  try {
    const [admins, peers] = await Promise.all([
      prisma.admin.count({ where: { passwordHash: { not: null } } }),
      prisma.clusterPeer.count({ where: { status: { in: ['ACTIVE', 'PENDING', 'DISABLED'] } } }),
    ]);
    return admins === 0 && peers === 0;
  } catch {
    return false;
  }
}

// ─── GET /api/setup/status ────────────────────────────────────────────────────

router.get('/status', async (_req: Request, res: Response): Promise<void> => {
  res.json({
    needsSetup: await setupOpen(),
    ingressManagedExternally: true,
  });
});

// Two simultaneous requests must not both pass the check above.
let setupRunning = false;

// ─── POST /api/setup/password ─────────────────────────────────────────────────

router.post('/password', authLimiter, async (req: Request, res: Response): Promise<void> => {
  if (setupRunning) {
    res.status(409).json({ error: 'Setup is already in progress' });
    return;
  }
  setupRunning = true;
  try {
    await completeSetup(req, res);
  } finally {
    setupRunning = false;
  }
});

async function completeSetup(req: Request, res: Response): Promise<void> {
  if (!(await setupOpen())) {
    res.status(403).json({ error: 'Admin password already configured. Use the admin panel to change it.' });
    return;
  }

  const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    res.status(400).json({ error: 'Username and password required' });
    return;
  }
  if (!USERNAME.test(username)) {
    res.status(400).json({ error: 'Username must be 3–64 characters: letters, digits, dot, dash or underscore' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    res.status(400).json({ error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters` });
    return;
  }

  const hash = await bcrypt.hash(password, config.bcryptRounds);
  updateEnvFile('ADMIN_USERNAME', username);
  updateEnvFile('ADMIN_PASSWORD_HASH', hash);

  config.adminUsername = username;
  config.adminPasswordHash = hash;
  config.adminUsernames = [username, ...config.adminUsernames.filter((entry) => entry !== username)];
  const token = jwt.sign(
    { role: 'admin', sub: 'admin-panel', username },
    config.jwtSecret,
    { expiresIn: '8h' },
  );

  res.json({ ok: true, token });
}

export { router as setupRouter };
