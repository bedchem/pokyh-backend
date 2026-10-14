import express, { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { logger } from '../utils/logger';
import { isAllowed, parseAllowlist } from './netpolicy';
import { handlePairConfirm, handlePairInit } from './pairing';
import { state } from './runtime';
import { MAX_FRAME_BYTES, handleRpc, handleSession } from './transport';

// HTTP surface of the node-to-node protocol, served under /cluster/v1 in two
// places, each switched in .env:
//
//   'public'     on the ordinary API port (CLUSTER_PUBLIC_PATH), for nodes
//                that reach each other through a reverse proxy. Mounted ahead
//                of the API-key check and the JSON body parser: these
//                endpoints authenticate cryptographically and carry opaque
//                binary frames. The caller's address is the one TRUST_PROXY
//                lets through.
//   'dedicated'  on a listener of its own (CLUSTER_PORT) that serves nothing
//                else; the caller's address is the socket's own.
//
// CLUSTER_ALLOWLIST limits both to the listed addresses. Everything a caller
// can reach without holding a key is cheap to refuse and rate limited per
// address.

export const allowlist = parseAllowlist(config.cluster.allowlist);

if (allowlist.invalid.length > 0) {
  logger.warn('CLUSTER_ALLOWLIST contains entries that are not addresses or CIDR ranges; they match nothing', {
    action: 'cluster_allowlist_invalid',
    entries: allowlist.invalid.slice(0, 10),
  });
}

export type EntryPoint = 'public' | 'dedicated';

function refuseQuietly(res: Response): void {
  // Deliberately the same answer as for a disabled feature.
  res.status(404).json({ error: 'Not found' });
}

export function createClusterRouter(entry: EntryPoint): Router {
  const router = Router();
  let refusedLogged = 0;

  router.use((req: Request, res: Response, next: NextFunction) => {
    const address = entry === 'public' ? req.ip : req.socket.remoteAddress;
    if (!isAllowed(allowlist, address)) {
      // Logged at most once a minute, so a scan cannot flood the log.
      if (Date.now() - refusedLogged > 60_000) {
        refusedLogged = Date.now();
        logger.warn('Cluster request from an address outside CLUSTER_ALLOWLIST refused', { action: 'cluster_allowlist_refused', entry });
      }
      refuseQuietly(res);
      return;
    }
    if (!config.cluster.enabled || !state.started) {
      refuseQuietly(res);
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const limiterOptions = {
    windowMs: 60 * 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
  } as const;

  // Each pairing attempt can cost a memory-hard key derivation.
  const pairLimiter = rateLimit({ ...limiterOptions, max: 20 });
  const sessionLimiter = rateLimit({ ...limiterOptions, max: 120 });
  // Established sessions are not limited; only calls that fail authentication
  // count, which bounds what guessing at session ids can cost.
  const rpcLimiter = rateLimit({ ...limiterOptions, max: 240, skipSuccessfulRequests: true });

  const smallJson = express.json({ limit: '8kb' });

  router.post('/pair/init', pairLimiter, smallJson, handlePairInit);
  router.post('/pair/confirm', pairLimiter, smallJson, handlePairConfirm);
  router.post('/session', sessionLimiter, smallJson, handleSession);
  router.post(
    '/rpc',
    rpcLimiter,
    express.raw({ type: () => true, limit: MAX_FRAME_BYTES + 64 }),
    handleRpc,
  );

  router.use((_req: Request, res: Response) => {
    refuseQuietly(res);
  });
  return router;
}
