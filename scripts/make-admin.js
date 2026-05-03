#!/usr/bin/env node
// Usage: npm run make-admin <username>
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');
const { askNewPassword } = require('./_auth');

const prisma = new PrismaClient();

async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error('Usage: npm run make-admin <username>');
    process.exit(1);
  }

  console.log(`\n── Make Admin: ${username} ────────────────────────\n`);

  let user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    console.log(`⚠️  User "${username}" not found — creating...`);
    const stableUid = uuidv4();
    user = await prisma.user.create({
      data: { id: uuidv4(), stableUid, username, webuntisKlasseId: 0, webuntisKlasseName: 'Admin' },
    });
    console.log(`✅ Created user "${username}"\n`);
  }

  const passwordHash = await askNewPassword(`Password for "${username}"`);

  await prisma.admin.upsert({
    where: { stableUid: user.stableUid },
    create: { stableUid: user.stableUid, canCreateClass: true, passwordHash },
    update: { canCreateClass: true, passwordHash },
  });

  console.log(`\n✅ "${username}" is now an admin — login with this password at /admin/\n`);
}

main()
  .catch(e => { console.error('❌', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
