import express from 'express';
import type { Server } from 'http';
import { config } from '../config';
import { logger } from '../utils/logger';
import { CLUSTER_PATH } from './protocol';
import { createClusterRouter } from './router';

// The dedicated listener for the node-to-node channel (CLUSTER_PORT). It
// serves /cluster/v1 and nothing else — no API, no admin panel — so it can be
// opened to the other nodes alone (firewall, CLUSTER_ALLOWLIST) while the API
// port stays behind the reverse proxy.

let server: Server | null = null;

export const listenerState = {
  listening: false,
  error: null as string | null,
};

export function startClusterListener(): void {
  if (!config.cluster.enabled || config.cluster.port === 0 || server) return;
  if (config.cluster.port === config.port) {
    listenerState.error = 'CLUSTER_PORT is the same as PORT';
    logger.error('CLUSTER_PORT must differ from PORT; the dedicated cluster listener was not started', { action: 'cluster_listener_failed' });
    return;
  }
  const app = express();
  app.disable('x-powered-by');
  // The socket address is the caller; no proxy header is believed here.
  app.set('trust proxy', false);
  app.use(CLUSTER_PATH, createClusterRouter('dedicated'));
  app.use((_req, res) => { res.status(404).json({ error: 'Not found' }); });

  server = app.listen(config.cluster.port, config.cluster.bindAddress, () => {
    listenerState.listening = true;
    listenerState.error = null;
    logger.info(`Cluster channel listening on ${config.cluster.bindAddress}:${config.cluster.port}`, { action: 'cluster_listener_started' });
  });
  server.on('error', (err) => {
    listenerState.listening = false;
    listenerState.error = err.message.split('\n')[0]!.slice(0, 200);
    logger.error('Cluster listener failed', { action: 'cluster_listener_failed', message: listenerState.error });
    server = null;
  });
  // Frames are small and frequent; idle sockets are closed quickly.
  server.keepAliveTimeout = 15_000;
  server.headersTimeout = 20_000;
  server.requestTimeout = config.cluster.syncTimeoutMs + 10_000;
}

export function stopClusterListener(): Promise<void> {
  const active = server;
  server = null;
  listenerState.listening = false;
  if (!active) return Promise.resolve();
  return new Promise((resolve) => {
    active.close(() => resolve());
    active.closeIdleConnections();
    setTimeout(() => { active.closeAllConnections(); resolve(); }, 3_000).unref();
  });
}
