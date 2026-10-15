import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { Admin, User } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../db';
import { adminPasswordHashes, matchEnvAdmin } from '../security/adminLogin';

/**
 * Who may open the admin panel and with which password — shared by the
 * password login, the passkey login and the re-authentication before a new
 * passkey is added.
 */

export type AdminAccount = {
  // The login name exactly as stored / configured; the admin JWT carries it
  // and requireAdmin looks it up again on every request.
  username: string;
  user: User | null;
  adminRecord: Admin | null;
  isEnvAdmin: boolean;
};

export type AdminLookup =
  | { ok: true; account: AdminAccount }
  | { ok: false; reason: 'no-account' | 'not-admin' };

async function findUser(username: string): Promise<User | null> {
  const exact = await prisma.user.findUnique({ where: { username } });
  if (exact) return exact;
  // Accounts made in the panel or through WebUntis are stored lower-case.
  const lower = username.toLowerCase();
  return lower === username ? null : prisma.user.findUnique({ where: { username: lower } });
}

export async function findAdminAccount(input: string): Promise<AdminLookup> {
  const typed = input.trim();
  if (!typed) return { ok: false, reason: 'no-account' };
  const user = await findUser(typed);
  const adminRecord = user ? await prisma.admin.findUnique({ where: { stableUid: user.stableUid } }) : null;
  const envName = matchEnvAdmin(user?.username ?? typed, config.adminUsernames);
  if (adminRecord) return { ok: true, account: { username: user!.username, user, adminRecord, isEnvAdmin: envName !== null } };
  // The configured spelling, so requireAdmin's env check matches it again.
  if (envName) return { ok: true, account: { username: envName, user, adminRecord: null, isEnvAdmin: true } };
  return { ok: false, reason: user ? 'not-admin' : 'no-account' };
}

export type PasswordCheck = 'ok' | 'wrong' | 'no-password';

export async function checkAdminPassword(account: AdminAccount, password: string): Promise<PasswordCheck> {
  const hashes = adminPasswordHashes({
    adminHash: account.adminRecord?.passwordHash,
    userHash: account.user?.passwordHash,
    sharedHash: config.adminPasswordHash,
  });
  if (hashes.length === 0) return 'no-password';
  for (const hash of hashes) {
    if (await bcrypt.compare(password, hash)) return 'ok';
  }
  return 'wrong';
}

export function issueAdminToken(username: string): string {
  return jwt.sign(
    { role: 'admin', sub: 'admin-panel', username },
    config.jwtSecret,
    { expiresIn: config.adminJwtExpiresIn } as jwt.SignOptions,
  );
}
