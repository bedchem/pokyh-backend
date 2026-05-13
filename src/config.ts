import 'dotenv/config';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

const jwtSecret = requireEnv('JWT_SECRET');
if (jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters long');
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '4000', 10),
  databaseUrl: requireEnv('DATABASE_URL'),
  jwtSecret,
  refreshTokenSecret: requireEnv('REFRESH_TOKEN_SECRET'),
  apiKey: requireEnv('API_KEY'),
  serverKey: requireEnv('SERVER_KEY'),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
  webuntisSchool: process.env.WEBUNTIS_SCHOOL ?? '',
  isDev: (process.env.NODE_ENV ?? 'development') === 'development',
  isProd: process.env.NODE_ENV === 'production',
  jwtExpiresIn: '1h',
  refreshTokenExpiresInHours: 1,
  adminUsername: process.env.ADMIN_USERNAME ?? '',
  adminUsernames: (process.env.ADMIN_USERNAMES ?? process.env.ADMIN_USERNAME ?? '')
    .split(',').map((u) => u.trim()).filter(Boolean),
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ?? '',
  debug: process.env.DEBUG === 'true',
  tunnelName: process.env.TUNNEL_NAME ?? '',
  tunnelHostname: process.env.TUNNEL_HOSTNAME ?? '',
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
  vapidEmail: process.env.VAPID_EMAIL ?? 'contact@pokyh.com',
  webuntisBase: process.env.WEBUNTIS_BASE ?? 'https://lbs-brixen.webuntis.com/WebUntis',
};
