#!/usr/bin/env node
// Usage: npm run create-user
require('dotenv').config({ quiet: true });
const readline = require('readline');
const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');
const { askNewPassword } = require('./_auth');

const prisma = new PrismaClient();

function makeRl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, q) {
  return new Promise(res => rl.question(q, res));
}

async function main() {
  console.log('\n── Create User ──────────────────────────────\n');

  let rl = makeRl();

  const username = (await ask(rl, '  Username: ')).trim();
  if (!username) { console.error('❌ Username required'); process.exit(1); }

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) { console.error(`❌ User "${username}" already exists`); process.exit(1); }

  const klasseIdRaw = (await ask(rl, '  WebUntis Klasse ID (default 0): ')).trim();
  const webuntisKlasseId = klasseIdRaw ? parseInt(klasseIdRaw, 10) : 0;
  if (isNaN(webuntisKlasseId)) { console.error('❌ Klasse ID must be a number'); process.exit(1); }

  const webuntisKlasseName = (await ask(rl, '  WebUntis Klasse Name (default "Unknown"): ')).trim() || 'Unknown';

  const makeAdminRaw = (await ask(rl, '  Make admin? (y/N): ')).trim().toLowerCase();
  const makeAdmin = makeAdminRaw === 'y' || makeAdminRaw === 'yes';

  rl.close();

  let passwordHash = null;
  if (makeAdmin) {
    console.log();
    passwordHash = await askNewPassword(`Password for "${username}"`);
  }

  const stableUid = uuidv4();
  await prisma.user.create({
    data: { id: uuidv4(), stableUid, username, webuntisKlasseId, webuntisKlasseName },
  });

  console.log(`\n✅ Created user "${username}" (${stableUid.slice(0, 8)}...)`);

  if (makeAdmin) {
    await prisma.admin.create({ data: { stableUid, canCreateClass: true, passwordHash } });
    console.log(`✅ Granted admin access — login at /admin/ with the password you set`);
  }

  console.log();
}

main()
  .catch(e => { console.error('❌', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
