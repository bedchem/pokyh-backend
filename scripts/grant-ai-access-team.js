#!/usr/bin/env node
// Usage: npm run grant-ai-access-team <team-id-or-exact-name> ["note"]
// Grants every current and future member of a team assistant access, without
// an individual LearnAiAccessGrant row per person. Phase 0 has no admin UI
// yet for this (that ships in Phase 1) — interim CLI, same style as
// grant-ai-access.js.
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
  const note = process.argv[3] ?? '';
  if (!idOrName) {
    console.error('Usage: npm run grant-ai-access-team <team-id-or-exact-name> ["note"]');
    process.exit(1);
  }

  const team = await resolveTeam(idOrName);
  if (!team) {
    console.error(`❌ No team found matching "${idOrName}"`);
    process.exit(1);
  }

  await prisma.learnAiTeamAccessGrant.upsert({
    where: { teamId: team.id },
    create: { teamId: team.id, grantedBy: 'cli', note },
    update: { grantedBy: 'cli', note, revokedBy: null, revokedAt: null, grantedAt: new Date() },
  });

  console.log(`✅ Team "${team.name}" (${team.id}) now has AI assistant access for every member`);
}

main()
  .catch((e) => { console.error('❌', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
