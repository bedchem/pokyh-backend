// Admin rights for the command-line tools. Whoever runs these scripts has the
// server and its database in hand — the same standing as an operator in
// ADMIN_USERNAMES — so an admin made here is a global admin, as before
// permissions existed. Rights for one school are given in the panel
// ("Admins & Rechte").
const { createHash } = require('crypto');

function catalog() {
  try {
    return require('../dist/security/permissions');
  } catch {
    throw new Error('The permission catalog is read from dist/ — run "npm run build" first.');
  }
}

function grantId(username, scope) {
  return createHash('sha256').update(`pokyh:admin-grant:${username.trim().toLowerCase()}|${scope}`).digest('hex');
}

async function grantGlobalAdmin(prisma, username, grantedBy) {
  const { ALL_PERMISSIONS, GLOBAL_SCOPE } = catalog();
  const id = grantId(username, GLOBAL_SCOPE);
  const permissions = JSON.stringify(ALL_PERMISSIONS);
  await prisma.adminGrant.upsert({
    where: { id },
    create: { id, username, scope: GLOBAL_SCOPE, preset: 'global_admin', permissions, grantedBy },
    update: { preset: 'global_admin', permissions, grantedBy },
  });
  await prisma.adminAuditEvent.create({
    data: { actor: grantedBy, action: 'admin.grant.set', targetType: 'admin', targetId: username, detail: JSON.stringify({ scope: GLOBAL_SCOPE, preset: 'global_admin', via: 'cli' }) },
  });
}

module.exports = { grantGlobalAdmin };
