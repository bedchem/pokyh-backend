// The command-line tools' database client: the server's own driver adapter
// (src/dbAdapter.ts), with DATABASE_URL from the environment or `.env`.
const { PrismaClient } = require('@prisma/client');

function createPrisma() {
  let mysqlAdapter;
  try {
    ({ mysqlAdapter } = require('../dist/dbAdapter'));
  } catch {
    throw new Error('The database connection is read from dist/ — run "npm run build" first.');
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  return new PrismaClient({ adapter: mysqlAdapter(url, 2) });
}

// Ends every admin panel session of the account (services/adminLogin.ts:
// tokens issued before this moment are refused), after its password or
// second factor was reset here.
async function endPanelSessions(prisma, username) {
  const from = new Date(Math.ceil(Date.now() / 1000) * 1000);
  await prisma.adminSecurity.upsert({
    where: { username },
    create: { username, tokensValidFrom: from },
    update: { tokensValidFrom: from },
  });
}

module.exports = { createPrisma, endPanelSessions };
