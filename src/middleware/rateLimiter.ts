import rateLimit from 'express-rate-limit';
import { config } from '../config';

export const globalLimiter = rateLimit({
  windowMs: config.rateLimit.globalWindowMs,
  max: config.rateLimit.globalMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) => req.method === 'OPTIONS',
});

export const authLimiter = rateLimit({
  windowMs: config.rateLimit.authWindowMs,
  max: config.rateLimit.authMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' },
});

export const writeLimiter = rateLimit({
  windowMs: config.rateLimit.writeWindowMs,
  max: config.rateLimit.writeMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many write requests, please slow down.' },
});

export const readLimiter = rateLimit({
  windowMs: config.rateLimit.readWindowMs,
  max: config.rateLimit.readMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many read requests, please slow down.' },
});

export const sseLimiter = rateLimit({
  windowMs: config.rateLimit.sseWindowMs,
  max: config.rateLimit.sseMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many SSE connections from this IP.' },
});
