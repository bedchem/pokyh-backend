import { randomBytes } from 'crypto';

export function generateStableUid(): string {
  return randomBytes(16).toString('hex');
}

export function generateClassCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

export function generateClassId(): string {
  return randomBytes(12).toString('hex');
}
