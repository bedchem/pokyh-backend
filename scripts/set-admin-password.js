#!/usr/bin/env node
// Usage: npm run set-admin-password <username>
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const { askNewPassword } = require('./_auth');

const prisma = new PrismaClient();

async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error('Usage: npm run set-admin-password <username>');
    process.exit(1);
  }

  console.log(`\n── Change Password: ${username} ───────────────────\n`);

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    console.error(`❌ User "${username}" not found`);
    process.exit(1);
  }

  const admin = await prisma.admin.findUnique({ where: { stableUid: user.stableUid } });
  if (!admin) {
    console.error(`❌ "${username}" is not an admin — run npm run make-admin first`);
    process.exit(1);
  }

  const passwordHash = await askNewPassword(`New password for "${username}"`);

  await prisma.admin.update({
    where: { stableUid: user.stableUid },
    data: { passwordHash },
  });

  console.log(`\n✅ Password updated for "${username}"\n`);
}

main()
  .catch(e => { console.error('❌', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
