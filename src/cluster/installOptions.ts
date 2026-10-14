import { isIP } from 'net';

// How a server set up with the one-line installer is reached (provision.ts,
// deploy/node). Pure, tested on its own (tests/clusterInstall).
//
//   web "none"    no web address of its own: clients keep using the existing
//                 ones; only the cluster port is open;
//   web "domain"  its own HTTPS (Caddy, Let's Encrypt) on 80/443 for a domain
//                 that points at it;
//   web "proxy"   behind the administrator's own proxy: the API is published
//                 on a port of choice, on an address of choice (e.g. only the
//                 WireGuard interface) and, in the firewall, only for the
//                 proxy's addresses.
//
// The cluster port is chosen the same way: port, address, allowed sources.

export type WebMode = 'none' | 'domain' | 'proxy';

export interface InstallOptions {
  web: WebMode;
  apiPort: number;
  apiBind: string;
  apiFrom: string[];
  clusterPort: number;
  clusterBind: string;
  clusterFrom: string[];
}

export interface InstallOptionsInput {
  web?: string;
  apiPort?: number;
  apiBind?: string;
  apiFrom?: string;
  clusterPort?: number;
  clusterBind?: string;
  clusterFrom?: string;
}

const MAX_SOURCES = 16;

// An IPv4/IPv6 address or CIDR range; the canonical text or null.
export function parseSource(text: string): string | null {
  const value = text.trim();
  const slash = value.indexOf('/');
  const address = slash >= 0 ? value.slice(0, slash) : value;
  const family = isIP(address);
  if (family === 0) return null;
  if (slash < 0) return address;
  const bits = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(bits) || Number(bits) > (family === 4 ? 32 : 128)) return null;
  return `${address}/${Number(bits)}`;
}

export function parseSources(text: string | undefined, label: string): string[] {
  const parts = (text ?? '').split(/[\s,]+/).filter(Boolean);
  if (parts.length > MAX_SOURCES) throw new Error(`${label}: at most ${MAX_SOURCES} addresses`);
  return parts.map((part) => {
    const source = parseSource(part);
    if (!source) throw new Error(`${label}: "${part.slice(0, 60)}" is not an IP address or range (e.g. 10.8.0.1 or 10.8.0.0/24)`);
    return source;
  });
}

function port(value: number | undefined, fallback: number, label: string): number {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen < 1 || chosen > 65_535) throw new Error(`${label} must be between 1 and 65535`);
  return chosen;
}

function bindAddress(value: string | undefined, label: string): string {
  const text = (value ?? '').trim().replace(/^\[|\]$/g, '');
  if (text === '' || text === '0.0.0.0') return '';
  if (isIP(text) === 0) throw new Error(`${label} must be an IP address of the new server (or empty for all)`);
  return text;
}

// `defaults` are this node's own ports (CLUSTER_MTLS_PORT, PORT): a new node
// is set up like the one that invites it unless chosen otherwise.
export function normalizeInstallOptions(
  input: InstallOptionsInput,
  context: { addressIsDomain: boolean; defaults: { clusterPort: number; apiPort: number } },
): InstallOptions {
  const web: WebMode = input.web === 'proxy' ? 'proxy' : input.web === 'domain' ? 'domain' : input.web === 'none' ? 'none' : context.addressIsDomain ? 'domain' : 'none';
  if (web === 'domain' && !context.addressIsDomain) throw new Error('For its own HTTPS, enter the new server\'s domain as its address');
  const clusterPort = port(input.clusterPort, context.defaults.clusterPort, 'The cluster port');
  const apiPort = web === 'proxy' ? port(input.apiPort, context.defaults.apiPort, 'The API port') : 0;
  if (web === 'domain' && (clusterPort === 80 || clusterPort === 443)) throw new Error('With its own HTTPS, ports 80 and 443 are taken — choose another cluster port');
  if (web === 'proxy' && apiPort === clusterPort) throw new Error('The API port and the cluster port must differ');
  return {
    web,
    apiPort,
    apiBind: web === 'proxy' ? bindAddress(input.apiBind, 'The API address') : '',
    apiFrom: web === 'proxy' ? parseSources(input.apiFrom, 'Reachable from (API)') : [],
    clusterPort,
    clusterBind: bindAddress(input.clusterBind, 'The cluster address'),
    clusterFrom: parseSources(input.clusterFrom, 'Reachable from (cluster)'),
  };
}
