import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// The Prisma CLI (generate, db push, migrate diff, db execute). The server
// starts it with DATABASE_URL already worked out (src/config.ts); by hand it
// comes from `.env`. `prisma generate` needs no database, so a missing URL is
// only an error for the commands that connect.
loadEnv({ quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: process.env['DATABASE_URL'] ?? '' },
});
