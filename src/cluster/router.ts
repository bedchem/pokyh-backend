import express, { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { handlePairConfirm, handlePairInit } from './pairing';
import { state } from './runtime';
import { handleRpc, handleSession } from './transport';

// HTTP surface of the node-to-node protocol, mounted at /cluster/v1 ahead of
// the API-key check and the JSON body parser: these endpoints authenticate
// cryptographically, not with the application's API key, and carry opaque
// binary frames.
//
// Everything a caller can reach without holding a key is cheap to refuse and
// rate limited per address.

const router = Router();

router.use((_req: Request, res: Response, next: NextFunction) => {
  if (!config.cluster.enabled || !state.started) {
    res.status(404).json({ error: 'Not found' });
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
  express.raw({ type: () => true, limit: config.cluster.maxMessageBytes + 65_536 }),
  handleRpc,
);

router.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

export { router as clusterRouter };
