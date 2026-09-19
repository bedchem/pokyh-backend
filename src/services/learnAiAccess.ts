import { prisma } from '../db';
import { ForbiddenError } from '../utils/errors';

// The pilot allowlist is the ONLY thing that grants assistant access — there
// is deliberately no global on/off flag for end users (LearnAiConfig.enabled
// is a separate, independent kill-switch a platform administrator controls,
// not an access grant). A grant with revokedAt set is treated exactly like
// no grant at all.
export async function hasActiveAiGrant(stableUid: string): Promise<boolean> {
  const grant = await prisma.learnAiAccessGrant.findUnique({
    where: { stableUid },
    select: { revokedAt: true },
  });
  return grant !== null && grant.revokedAt === null;
}

export async function requireAiPilotAccess(stableUid: string): Promise<void> {
  if (!await hasActiveAiGrant(stableUid)) {
    throw new ForbiddenError('The assistant is not enabled for this account yet');
  }
}

export async function grantAiAccess(stableUid: string, grantedBy: string, note = ''): Promise<void> {
  await prisma.learnAiAccessGrant.upsert({
    where: { stableUid },
    create: { stableUid, grantedBy, note },
    update: { grantedBy, note, revokedBy: null, revokedAt: null, grantedAt: new Date() },
  });
}

export async function revokeAiAccess(stableUid: string, revokedBy: string): Promise<void> {
  await prisma.learnAiAccessGrant.updateMany({
    where: { stableUid, revokedAt: null },
    data: { revokedBy, revokedAt: new Date() },
  });
}

export interface AiAccessGrantSummary {
  stableUid: string;
  username: string;
  grantedBy: string;
  grantedAt: Date;
  revokedBy: string | null;
  revokedAt: Date | null;
  note: string;
}

export async function listAiAccessGrants(): Promise<AiAccessGrantSummary[]> {
  const grants = await prisma.learnAiAccessGrant.findMany({
    orderBy: { grantedAt: 'desc' },
    include: { user: { select: { username: true } } },
  });
  return grants.map((grant) => ({
    stableUid: grant.stableUid,
    username: grant.user.username,
    grantedBy: grant.grantedBy,
    grantedAt: grant.grantedAt,
    revokedBy: grant.revokedBy,
    revokedAt: grant.revokedAt,
    note: grant.note,
  }));
}
