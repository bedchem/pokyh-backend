import { Response } from 'express';
import { config } from '../config';

interface SseClient {
  res: Response;
  heartbeatInterval: NodeJS.Timeout;
  // Who is listening — lets a broadcast tailor the payload per viewer (e.g.
  // myRating) instead of sending one user's view to everyone.
  stableUid?: string;
}

class SseManager {
  private clients: Map<string, Set<SseClient>> = new Map();

  addClient(key: string, res: Response, stableUid?: string): void {
    if (!this.clients.has(key)) {
      this.clients.set(key, new Set());
    }

    const heartbeatInterval = setInterval(() => {
      try {
        res.write('data: {"type":"heartbeat"}\n\n');
      } catch {
        this.removeClientByRes(key, res);
      }
    }, config.sseHeartbeatMs);

    const client: SseClient = { res, heartbeatInterval, stableUid };
    this.clients.get(key)!.add(client);

    // Clean up on disconnect
    res.on('close', () => {
      this.removeClient(key, client);
    });
  }

  removeClient(key: string, client: SseClient): void {
    clearInterval(client.heartbeatInterval);
    const set = this.clients.get(key);
    if (set) {
      set.delete(client);
      if (set.size === 0) {
        this.clients.delete(key);
      }
    }
  }

  removeClientByRes(key: string, res: Response): void {
    const set = this.clients.get(key);
    if (!set) return;
    for (const client of set) {
      if (client.res === res) {
        this.removeClient(key, client);
        return;
      }
    }
  }

  broadcast(key: string, event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.write(key, () => payload);
  }

  // Like broadcast, but builds the data for each listener from its stableUid.
  broadcastPerClient(key: string, event: string, dataFor: (stableUid: string | undefined) => unknown): void {
    this.write(key, (client) => `event: ${event}\ndata: ${JSON.stringify(dataFor(client.stableUid))}\n\n`);
  }

  private write(key: string, payloadFor: (client: SseClient) => string): void {
    const set = this.clients.get(key);
    if (!set || set.size === 0) return;

    const toRemove: SseClient[] = [];

    for (const client of set) {
      try {
        client.res.write(payloadFor(client));
      } catch {
        toRemove.push(client);
      }
    }

    for (const client of toRemove) {
      this.removeClient(key, client);
    }
  }

  getClientCount(key: string): number {
    return this.clients.get(key)?.size ?? 0;
  }
}

export const sseManager = new SseManager();
