import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { config } from '../config';

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
    ingressManagedExternally: true,
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
});

export { router as setupRouter };
