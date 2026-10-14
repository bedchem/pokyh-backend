import express, { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { logger } from '../utils/logger';
import { clientAddressOf, clientCertificateOf } from './mtls';
import { isAllowed, parseAllowlist } from './netpolicy';
import { handlePairConfirm, handlePairInit } from './pairing';
import { handleBundle, handleInstallScript, handleProvision } from './provision';
import { state } from './runtime';
import { MAX_FRAME_BYTES, handleRpc, handleSession, type ChannelContext } from './transport';

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
//   'mtls'       on the mutually authenticated channel (CLUSTER_MTLS_PORT,
//                mtls.ts). What a caller may reach there depends on the
//                certificate it presented:
//                  pinned for a peer  everything below;
//                  unknown            only pairing (while a window is open);
//                  none               only the one-line installer's three
//                                     endpoints (while an install is open).
//                The installer endpoints exist on this entry point only.
//
// CLUSTER_ALLOWLIST limits all of them to the listed addresses. Everything a
// caller can reach without holding a key is cheap to refuse and rate limited
// per address.

export const allowlist = parseAllowlist(config.cluster.allowlist);

if (allowlist.invalid.length > 0) {
  logger.warn('CLUSTER_ALLOWLIST contains entries that are not addresses or CIDR ranges; they match nothing', {
    action: 'cluster_allowlist_invalid',
    entries: allowlist.invalid.slice(0, 10),
  });
}

export type EntryPoint = 'public' | 'dedicated' | 'mtls';

// Which paths a caller of the mutually authenticated channel may reach,
// given what it presented.
function mtlsPathAllowed(pathname: string, certificate: 'pinned' | 'unknown' | 'none'): boolean {
  if (certificate === 'pinned') return true;
  if (certificate === 'unknown') return pathname === '/pair/init' || pathname === '/pair/confirm';
  return pathname === '/install.sh' || pathname === '/provision' || pathname === '/provision/bundle';
}

function refuseQuietly(res: Response): void {
  // Deliberately the same answer as for a disabled feature.
  res.status(404).json({ error: 'Not found' });
}

export function createClusterRouter(entry: EntryPoint): Router {
  const router = Router();
  let refusedLogged = 0;

  router.use((req: Request, res: Response, next: NextFunction) => {
    // On the channel, a connection handed over by a relay counts as coming
    // from the address the relay reported.
    const address = entry === 'public' ? req.ip : entry === 'mtls' ? clientAddressOf(req.socket) : req.socket.remoteAddress;
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
    const context: ChannelContext = { entry, client: entry === 'mtls' ? clientCertificateOf(req.socket) : null };
    if (entry === 'mtls') {
      const pinned = context.client !== null && [...state.peers.values()].some((peer) => peer.tls?.pin === context.client!.pin
        || (peer.tls?.previous && peer.tls.previous.until > Date.now() && peer.tls.previous.pin === context.client!.pin));
      const certificate = context.client === null ? 'none' : pinned ? 'pinned' : 'unknown';
      if (!mtlsPathAllowed(req.path, certificate)) {
        refuseQuietly(res);
        return;
      }
    }
    res.locals['clusterChannel'] = context;
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const limiterOptions = {
    windowMs: 60 * 1000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
    ...(entry === 'mtls' ? { keyGenerator: (req: Request) => clientAddressOf(req.socket) ?? 'unknown' } : {}),
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
  if (entry === 'mtls') {
    const installLimiter = rateLimit({ ...limiterOptions, max: 30 });
    router.get('/install.sh', installLimiter, handleInstallScript);
    router.post('/provision', installLimiter, smallJson, handleProvision);
    router.post('/provision/bundle', installLimiter, smallJson, handleBundle);
  }
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
