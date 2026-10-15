#!/usr/bin/env node
// Usage: npm run reset-admin-2fa <username>
// Removes the authenticator app, the recovery codes and every passkey of an
// admin panel login — for a lost phone or a changed JWT_SECRET. The password
// alone opens the panel again afterwards.
require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const username = process.argv[2];
  if (!username) {
    console.error('Usage: npm run reset-admin-2fa <username>');
    process.exit(1);
  }

  const [totp, passkeys] = await prisma.$transaction([
    prisma.adminTotp.deleteMany({ where: { username } }),
    prisma.adminPasskey.deleteMany({ where: { username } }),
  ]);

  if (totp.count === 0 && passkeys.count === 0) {
    console.log(`ℹ️  "${username}" had no second factor (the name is matched exactly)`);
  } else {
    console.log(`✅ "${username}": authenticator app ${totp.count ? 'removed' : 'not set up'}, ${passkeys.count} passkey(s) removed`);
  }
}

main()
  .catch(e => { console.error('❌', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
