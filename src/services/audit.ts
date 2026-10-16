import type { Request } from 'express';
import { prisma } from '../db';
import { logger } from '../utils/logger';

// The admin audit trail. Every sensitive change in the panel — permissions,
// accounts, moderation, menus, schools, system operations — is written here
// with who did it, to what, in which school and when. Read in the panel
// under "Admin-Aktivität" (GET /api/admin/audit-events), filtered to the
// schools the reader may see.
//
// `detail` holds what changed in a few words or keys — never a password, a
// one-time password, a token, a request body or a comment's text.

const MAX_DETAIL = 2000;

export interface AuditTarget {
  type: string;
  id: string;
}

function compactDetail(detail: Record<string, unknown>): string {
  let text = '{}';
  try {
    text = JSON.stringify(detail, (_key, value) => (typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…` : value));
  } catch {
    text = '{}';
  }
  return text.length > MAX_DETAIL ? JSON.stringify({ truncated: true }) : text;
}

// Best effort and never awaited by the caller's response: a failed audit
// write is logged, it does not undo the change. The file log keeps the same
// entry, so nothing is lost if the database write fails.
export function audit(
  req: Request | null,
  action: string,
  target: AuditTarget,
  detail: Record<string, unknown> = {},
  schoolId: string | null = req?.adminScope?.schoolId ?? null,
  actor: string = req?.adminUser?.username ?? 'system',
): void {
  const requestId = req?.id ?? null;
  logger.info('Admin audit', { action: 'admin_audit', auditAction: action, actor, targetType: target.type, targetId: target.id, schoolId, requestId, detail });
  prisma.adminAuditEvent.create({
    data: {
      actor: actor.slice(0, 191),
      action: action.slice(0, 60),
      targetType: target.type.slice(0, 40),
      targetId: target.id.slice(0, 191),
      schoolId,
      detail: compactDetail(detail),
      requestId: requestId ? String(requestId).slice(0, 64) : null,
    },
  }).catch((err) => {
    logger.warn('Admin audit event not stored', { action, message: err instanceof Error ? err.message.split('\n')[0] : String(err) });
  });
}
