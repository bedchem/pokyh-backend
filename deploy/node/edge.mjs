// Pokyh edge — the forwarder in front of the cluster channel port on servers
// set up by the installer. The two app containers of a blue/green update
// (deploy/node/compose.yml) cannot both publish the channel port, so this
// small process owns it and passes every connection on, unchanged, to
// whichever app container accepts it: the active one, and during an update
// the new one as soon as it listens. It first writes a PROXY protocol line
// (src/cluster/proxyProtocol.ts) so the app still knows the real client.
// TLS is never terminated here — the bytes stay encrypted end to end.
//
// Settings (environment):
//   EDGE_PORT            port to listen on                    4100
//   EDGE_TARGET_HOSTS    the app containers' names            app-blue,app-green
//   EDGE_TARGET_PORT     their channel port                   4100
//   EDGE_CONNECT_TIMEOUT_MS  per container address             1000
//   EDGE_STAGGER_MS          before trying the next address in
//                            parallel ("happy eyeballs")       150
//   EDGE_MAX_CONNECTIONS                                      4096

import dns from 'node:dns/promises';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

function intEnv(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export function proxyLine(client, local) {
  const src = (client.address ?? '').replace(/^::ffff:/, '');
  const dst = (local.address ?? '').replace(/^::ffff:/, '');
  const v4 = net.isIPv4(src) && net.isIPv4(dst);
  const v6 = net.isIPv6(src) && net.isIPv6(dst);
  if (!v4 && !v6) return 'PROXY UNKNOWN\r\n';
  return `PROXY ${v4 ? 'TCP4' : 'TCP6'} ${src} ${dst} ${client.port} ${local.port}\r\n`;
}

// The first container that accepts. Addresses are tried one after the other,
// but each next one already after `staggerMs` — so an address that just went
// away (a stopped colour still in a DNS answer) never holds a client up.
export function connectFirst(addresses, port, { timeoutMs, staggerMs }) {
  return new Promise((resolve, reject) => {
    const sockets = [];
    let started = 0;
    let failed = 0;
    let settled = false;
    let staggerTimer = null;
    const settle = (winner) => {
      settled = true;
      clearTimeout(staggerTimer);
      for (const socket of sockets) if (socket !== winner) socket.destroy();
      if (winner) resolve(winner); else reject(new Error('no container accepted the connection'));
    };
    const start = () => {
      clearTimeout(staggerTimer);
      if (settled || started >= addresses.length) return;
      const socket = net.connect({ host: addresses[started], port, allowHalfOpen: true });
      started += 1;
      sockets.push(socket);
      const timer = setTimeout(() => socket.destroy(), timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        if (!settled) settle(socket);
      });
      socket.once('close', () => {
        clearTimeout(timer);
        if (settled) return;
        failed += 1;
        // Failed before its turn was over: the next one right away.
        if (failed === addresses.length) settle(null);
        else start();
      });
      socket.on('error', () => {});
      staggerTimer = setTimeout(start, staggerMs);
    };
    if (addresses.length === 0) settle(null); else start();
  });
}

// Every address of every name that resolves (a stopped colour does not).
async function resolveAll(hosts, lookup) {
  const lists = await Promise.all(hosts.map((host) => lookup(host).catch(() => [])));
  return [...new Set(lists.flat().map((entry) => entry.address))];
}

export function createEdge({ targetHosts, targetPort, connectTimeoutMs, staggerMs = 150, maxConnections, lookup = (host) => dns.lookup(host, { all: true }) }) {
  let open = 0;
  // Half-open connections are passed on as they are: each direction ends
  // on its own, and the connection closes once both have.
  const server = net.createServer({ pauseOnConnect: true, allowHalfOpen: true }, async (client) => {
    if (open >= maxConnections) { client.destroy(); return; }
    open += 1;
    client.once('close', () => { open -= 1; });
    client.on('error', () => client.destroy());
    let upstream = null;
    try {
      const addresses = await resolveAll(targetHosts, lookup);
      upstream = await connectFirst(addresses, targetPort, { timeoutMs: connectTimeoutMs, staggerMs });
    } catch {
      upstream = null;
    }
    if (!upstream || client.destroyed) { upstream?.destroy(); client.destroy(); return; }
    upstream.write(proxyLine({ address: client.remoteAddress, port: client.remotePort }, { address: client.localAddress, port: client.localPort }));
    upstream.on('error', () => client.destroy());
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  });
  return server;
}

export async function main() {
  const port = intEnv('EDGE_PORT', 4100, 1, 65_535);
  const server = createEdge({
    targetHosts: (process.env.EDGE_TARGET_HOSTS || 'app-blue,app-green').split(',').map((host) => host.trim()).filter(Boolean),
    targetPort: intEnv('EDGE_TARGET_PORT', 4100, 1, 65_535),
    connectTimeoutMs: intEnv('EDGE_CONNECT_TIMEOUT_MS', 1_000, 100, 60_000),
    staggerMs: intEnv('EDGE_STAGGER_MS', 150, 10, 5_000),
    maxConnections: intEnv('EDGE_MAX_CONNECTIONS', 4096, 1, 1_000_000),
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), message: 'edge listening', port })}\n`);
  const stop = () => { server.close(); setTimeout(() => process.exit(0), 2_000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`edge could not start: ${err.message}\n`);
    process.exit(1);
  });
}
