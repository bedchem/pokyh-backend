import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

declare global {
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

// Assigns a correlation ID to every request so it can be traced across the
// Winston log lines and the RequestLog DB row it produces, and returned to
// the caller for cross-referencing support reports. Trusts an inbound
// X-Request-Id from the same-origin BFF (already API-key/JWT authenticated
// upstream); generates a fresh one otherwise.
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers['x-request-id'];
  req.id = (typeof inbound === 'string' && inbound.trim() !== '') ? inbound.trim().slice(0, 64) : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}
