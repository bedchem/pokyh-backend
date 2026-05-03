#!/usr/bin/env node
// Usage: npm run revoke-admin <username>
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error('Usage: npm run revoke-admin <username>');
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    console.error(`❌ User "${username}" not found`);
    process.exit(1);
  }

  const deleted = await prisma.admin.deleteMany({ where: { stableUid: user.stableUid } });
  if (deleted.count === 0) {
    console.log(`ℹ️  "${username}" was not an admin`);
  } else {
    console.log(`✅ "${username}" admin access revoked`);
  }
}

main()
  .catch(e => { console.error('❌', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
