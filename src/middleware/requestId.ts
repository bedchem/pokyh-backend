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
// the caller for cross-referencing support reports. Only a strictly bounded,
// printable inbound value is accepted; every other value is replaced so an
// unauthenticated caller cannot inject formatting/control characters into logs.
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.headers['x-request-id'];
  const candidate = typeof inbound === 'string' ? inbound.trim() : '';
  req.id = /^[A-Za-z0-9._-]{8,64}$/.test(candidate) ? candidate : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}
