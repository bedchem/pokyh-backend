import { prisma } from '../db';
import { logger } from '../utils/logger';
import { revokeUserTokens } from '../utils/revokedTokens';
import { audit } from './audit';
import { rememberSchoolTenant } from './schools';
import { revokeSessions } from './sessions';

/**
 * The school's WebUntis tenant after a verified sign-in of `tenantId`
 * (services/schools.ts rememberSchoolTenant): the caller refuses the sign-in
 * when it is another one. When a sign-in POKYH made itself with the password
 * or key replaces a tenant that was recorded first (an app's session of
 * another school on the same WebUntis host), every account of the school
 * bound to that tenant loses its sessions and its class: they signed in with
 * another school's sessions.
 */
export async function settleSchoolTenant(schoolId: string, tenantId: string, certain: boolean): Promise<string | null> {
  const { tenant, replaced } = await rememberSchoolTenant(schoolId, tenantId, { certain });
  if (replaced) await endForeignAccounts(schoolId, replaced);
  return tenant;
}

async function endForeignAccounts(schoolId: string, foreignTenant: string): Promise<void> {
  const accounts = await prisma.user.findMany({ where: { schoolId, webuntisTenantId: foreignTenant }, select: { stableUid: true } });
  for (const { stableUid } of accounts) {
    await revokeSessions(stableUid);
    revokeUserTokens(stableUid);
  }
  if (accounts.length > 0) {
    const stableUids = accounts.map((a) => a.stableUid);
    await prisma.$transaction([
      prisma.classMember.deleteMany({ where: { stableUid: { in: stableUids } } }),
      prisma.user.updateMany({
        where: { stableUid: { in: stableUids } },
        data: { webuntisKlasseId: 0, webuntisKlasseName: '', classCheckVersion: 0, classSource: null, classNote: null },
      }),
    ]);
  }
  logger.warn('Accounts of another WebUntis tenant signed out of the school', { action: 'school_tenant_foreign_accounts', schoolId, accounts: accounts.length });
  audit(null, 'school.tenant_replaced', { type: 'school', id: schoolId }, { accountsSignedOut: accounts.length }, schoolId);
}
