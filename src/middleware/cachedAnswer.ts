import type { NextFunction, Request, Response } from 'express';
import { TtlCache } from '../utils/cache';
import { scopeSchool } from './requireAdmin';

// The admin panel asks for its figures again on every live update and from
// every open tab; most of them aggregate thousands of log rows. An answer is
// kept for `ttlMs` per admin, school view and query, and requests arriving
// while it is being computed wait for that computation instead of starting
// their own. Mounted after requireAdmin and requirePermission: every request
// is still authorised on its own; only the work behind it is shared.

export function cachedAnswer(ttlMs: number) {
  const done = new TtlCache<unknown>(ttlMs, 500);
  const running = new Map<string, Promise<unknown>>();
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const query = new URLSearchParams(Object.entries(req.query).flatMap(([k, v]): Array<[string, string]> => (typeof v === 'string' ? [[k, v]] : []))).toString();
    const key = `${req.baseUrl}${req.path}?${query}|${scopeSchool(req) ?? '*'}|${req.adminUser?.username ?? ''}`;
    const hit = done.get(key);
    if (hit !== undefined) {
      res.json(hit);
      return;
    }
    const pending = running.get(key);
    if (pending) {
      const value = await pending;
      if (value !== undefined) {
        res.json(value);
        return;
      }
    }
    let settle: (value: unknown) => void = () => undefined;
    running.set(key, new Promise((resolve) => { settle = resolve; }));
    const finish = (value: unknown) => {
      if (running.has(key)) {
        running.delete(key);
        settle(value);
      }
    };
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      const ok = res.statusCode === 200;
      if (ok) done.set(key, body);
      finish(ok ? body : undefined);
      return json(body);
    };
    // An error or a dropped connection: the waiting requests compute on their own.
    res.on('close', () => finish(undefined));
    next();
  };
}
