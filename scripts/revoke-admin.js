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
  // The rights go with the admin standing, so a later new grant starts from nothing.
  await prisma.adminGrant.deleteMany({ where: { username: user.username } });
  // Second factors must not come back to life if the name is made admin again.
  await prisma.adminTotp.deleteMany({ where: { username: user.username } });
  await prisma.adminPasskey.deleteMany({ where: { username: user.username } });
  if (deleted.count === 0) {
    console.log(`ℹ️  "${username}" was not an admin`);
  } else {
    console.log(`✅ "${username}" admin access revoked`);
  }
}

main()
  .catch(e => { console.error('❌', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
