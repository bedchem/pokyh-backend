#!/usr/bin/env node
// Usage: npm run revoke-ai-access-team <team-id-or-exact-name>
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function resolveTeam(idOrName) {
  const byId = await prisma.learnTeam.findUnique({ where: { id: idOrName } });
  if (byId) return byId;

  const byName = await prisma.learnTeam.findMany({ where: { name: idOrName } });
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    console.error(`❌ Multiple teams are named "${idOrName}" — rerun with one of these IDs instead:`);
    for (const team of byName) console.error(`   ${team.id}`);
    process.exit(1);
  }
  return null;
}

async function main() {
  const idOrName = process.argv[2];
  if (!idOrName) {
    console.error('Usage: npm run revoke-ai-access-team <team-id-or-exact-name>');
    process.exit(1);
  }

  const team = await resolveTeam(idOrName);
  if (!team) {
    console.error(`❌ No team found matching "${idOrName}"`);
    process.exit(1);
  }

  const result = await prisma.learnAiTeamAccessGrant.updateMany({
    where: { teamId: team.id, revokedAt: null },
    data: { revokedBy: 'cli', revokedAt: new Date() },
  });

  if (result.count === 0) {
    console.log(`ℹ️  Team "${team.name}" had no active AI vocabulary trainer grant`);
    return;
  }
  console.log(`✅ Team "${team.name}"'s AI vocabulary trainer access has been revoked`);
}

main()
  .catch((e) => { console.error('❌', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
