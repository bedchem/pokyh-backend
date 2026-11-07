import { Response } from 'express';
import { config } from '../config';

interface SseClient {
  res: Response;
  key: string;
  // Who is listening — lets a broadcast tailor the payload per viewer (e.g.
  // myRating) instead of sending one user's view to everyone.
  stableUid?: string;
}

// Open streams one account may hold at once (website tabs and the apps
// together, every kind of stream). Past it the account's oldest stream is
// closed: its tab reconnects when it is looked at again. Without a bound one
// account could hold thousands of sockets open.
const MAX_STREAMS_PER_ACCOUNT = 20;
const HEARTBEAT = 'data: {"type":"heartbeat"}\n\n';

class SseManager {
  private clients: Map<string, Set<SseClient>> = new Map();
  // Per account, its streams in the order they opened.
  private byAccount: Map<string, SseClient[]> = new Map();
  // One timer beats for every stream (not one timer per connection).
  private heartbeat: NodeJS.Timeout | null = null;

  addClient(key: string, res: Response, stableUid?: string): void {
    if (!this.clients.has(key)) {
      this.clients.set(key, new Set());
    }

    const client: SseClient = { res, key, stableUid };
    this.clients.get(key)!.add(client);

    if (stableUid) {
      const own = this.byAccount.get(stableUid) ?? [];
      own.push(client);
      this.byAccount.set(stableUid, own);
      while (own.length > MAX_STREAMS_PER_ACCOUNT) {
        const oldest = own.shift()!;
        this.removeClient(oldest.key, oldest);
        try { oldest.res.end(); } catch { /* already gone */ }
      }
    }
    this.startHeartbeat();

    // Clean up on disconnect
    res.on('close', () => {
      this.removeClient(key, client);
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const [key, set] of this.clients) {
        for (const client of [...set]) {
          try {
            client.res.write(HEARTBEAT);
          } catch {
            this.removeClient(key, client);
          }
        }
      }
      if (this.clients.size === 0 && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
    }, config.sseHeartbeatMs);
    this.heartbeat.unref();
  }

  removeClient(key: string, client: SseClient): void {
    const set = this.clients.get(key);
    if (set) {
      set.delete(client);
      if (set.size === 0) {
        this.clients.delete(key);
      }
    }
    if (client.stableUid) {
      const own = this.byAccount.get(client.stableUid);
      if (own) {
        const i = own.indexOf(client);
        if (i >= 0) own.splice(i, 1);
        if (own.length === 0) this.byAccount.delete(client.stableUid);
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
    const set = this.clients.get(key);
    if (!set || set.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.write(key, () => payload);
  }

  // Like broadcast, but builds the data for each listener from its stableUid.
  broadcastPerClient(key: string, event: string, dataFor: (stableUid: string | undefined) => unknown): void {
    // Listeners with the same account (or none) get the same text: built once each.
    const built = new Map<string, string>();
    this.write(key, (client) => {
      const who = client.stableUid ?? '';
      let text = built.get(who);
      if (text === undefined) {
        text = `event: ${event}\ndata: ${JSON.stringify(dataFor(client.stableUid))}\n\n`;
        built.set(who, text);
      }
      return text;
    });
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
