#!/usr/bin/env node
// Usage: npm run revoke-ai-access <username>
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error('Usage: npm run revoke-ai-access <username>');
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    console.error(`❌ User "${username}" not found`);
    process.exit(1);
  }

  const result = await prisma.learnAiAccessGrant.updateMany({
    where: { stableUid: user.stableUid, revokedAt: null },
    data: { revokedBy: 'cli', revokedAt: new Date() },
  });

  if (result.count === 0) {
    console.log(`ℹ️  "${username}" had no active AI assistant grant`);
    return;
  }
  console.log(`✅ "${username}"'s AI assistant pilot access has been revoked`);
}

main()
  .catch((e) => { console.error('❌', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
