#!/usr/bin/env node
// Usage: npm run decrypt-backup <file.enc> [output]
//
// Turns an off-site backup copy (downloaded from the bucket) back into the
// original file — a pokyh-backup-*.sql.gz dump, a base dump or a binary log.
// Needs BACKUP_ENCRYPTION_KEY (from .env or the environment), the same key the
// server encrypted it with (services/offsite.ts). Works offline; nothing else
// is needed. A dump can then be put into BACKUP_DIR and restored in the admin
// panel, or loaded with: gunzip -c pokyh-backup-….sql.gz | mysql <database>
require('dotenv').config({ quiet: true });
const { createDecipheriv, createHash } = require('crypto');
const fs = require('fs');

const MAGIC = Buffer.from('PKYB1\n');

function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: npm run decrypt-backup <file.enc> [output]');
    process.exit(1);
  }
  const output = process.argv[3] || input.replace(/\.enc$/, '');
  if (output === input) {
    console.error('Name the output file (the input does not end in .enc).');
    process.exit(1);
  }
  const secret = (process.env.BACKUP_ENCRYPTION_KEY || '').trim();
  if (!secret) {
    console.error('BACKUP_ENCRYPTION_KEY is not set.');
    process.exit(1);
  }

  const sealed = fs.readFileSync(input);
  if (sealed.length < MAGIC.length + 28 || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
    console.error('This is not an encrypted Pokyh backup.');
    process.exit(1);
  }
  const key = createHash('sha256').update(`${secret}:pokyh-offsite-backup`).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(MAGIC.length, MAGIC.length + 12));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  let plain;
  try {
    plain = Buffer.concat([decipher.update(sealed.subarray(MAGIC.length + 12, sealed.length - 16)), decipher.final()]);
  } catch {
    console.error('Decryption failed: wrong BACKUP_ENCRYPTION_KEY, or the file is damaged.');
    process.exit(1);
  }
  fs.writeFileSync(output, plain);
  console.log(`Written: ${output} (${plain.length} bytes, sha256 ${createHash('sha256').update(plain).digest('hex')})`);
}

main();
