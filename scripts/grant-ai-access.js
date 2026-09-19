#!/usr/bin/env node
// Usage: npm run grant-ai-access <username> ["note"]
// Phase 0 has no admin UI yet for the AI assistant pilot allowlist (that
// ships in Phase 1) — this script is the interim way to add a pilot user,
// mirroring the existing make-admin.js/create-user.js scripts.
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const username = process.argv[2];
  const note = process.argv[3] ?? '';
  if (!username) {
    console.error('Usage: npm run grant-ai-access <username> ["note"]');
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    console.error(`❌ User "${username}" not found`);
    process.exit(1);
  }

  await prisma.learnAiAccessGrant.upsert({
    where: { stableUid: user.stableUid },
    create: { stableUid: user.stableUid, grantedBy: 'cli', note },
    update: { grantedBy: 'cli', note, revokedBy: null, revokedAt: null, grantedAt: new Date() },
  });

  console.log(`✅ "${username}" now has AI assistant pilot access`);
}

main()
  .catch((e) => { console.error('❌', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
