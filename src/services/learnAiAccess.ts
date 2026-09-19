import { prisma } from '../db';
import { ForbiddenError } from '../utils/errors';

// The pilot allowlist is the ONLY thing that grants vocabulary-trainer access — there
// is deliberately no global on/off flag for end users (LearnAiConfig.enabled
// is a separate, independent kill-switch a platform administrator controls,
// not an access grant). A grant with revokedAt set is treated exactly like
// no grant at all. Access comes from either a personal grant OR membership
// in a team that has an active LearnAiTeamAccessGrant — an administrator can
// onboard a whole team at once instead of granting every member individually.
export async function hasActiveAiGrant(stableUid: string): Promise<boolean> {
  const [personalGrant, teamGrant] = await Promise.all([
    prisma.learnAiAccessGrant.findUnique({
      where: { stableUid },
      select: { revokedAt: true },
    }),
    prisma.learnAiTeamAccessGrant.findFirst({
      where: { revokedAt: null, team: { members: { some: { stableUid } } } },
      select: { teamId: true },
    }),
  ]);
  return (personalGrant !== null && personalGrant.revokedAt === null) || teamGrant !== null;
}

export async function requireAiPilotAccess(stableUid: string): Promise<void> {
  if (!await hasActiveAiGrant(stableUid)) {
    throw new ForbiddenError('The vocabulary trainer is not enabled for this account yet');
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

export async function grantAiAccessToTeam(teamId: string, grantedBy: string, note = ''): Promise<void> {
  await prisma.learnAiTeamAccessGrant.upsert({
    where: { teamId },
    create: { teamId, grantedBy, note },
    update: { grantedBy, note, revokedBy: null, revokedAt: null, grantedAt: new Date() },
  });
}

export async function revokeAiAccessFromTeam(teamId: string, revokedBy: string): Promise<void> {
  await prisma.learnAiTeamAccessGrant.updateMany({
    where: { teamId, revokedAt: null },
    data: { revokedBy, revokedAt: new Date() },
  });
}

export interface AiTeamAccessGrantSummary {
  teamId: string;
  teamName: string;
  memberCount: number;
  grantedBy: string;
  grantedAt: Date;
  revokedBy: string | null;
  revokedAt: Date | null;
  note: string;
}

export async function listAiTeamAccessGrants(): Promise<AiTeamAccessGrantSummary[]> {
  const grants = await prisma.learnAiTeamAccessGrant.findMany({
    orderBy: { grantedAt: 'desc' },
    include: { team: { select: { name: true, _count: { select: { members: true } } } } },
  });
  return grants.map((grant) => ({
    teamId: grant.teamId,
    teamName: grant.team.name,
    memberCount: grant.team._count.members,
    grantedBy: grant.grantedBy,
    grantedAt: grant.grantedAt,
    revokedBy: grant.revokedBy,
    revokedAt: grant.revokedAt,
    note: grant.note,
  }));
}
