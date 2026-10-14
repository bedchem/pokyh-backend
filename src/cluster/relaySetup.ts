import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import type { Request, Response } from 'express';
import { isIP } from 'net';
import { isServerName } from './endpoints';
import { ClusterError } from './errors';

// Setting up a Pokyh relay on a server with a public address (a VPS): the
// admin panel asks for a command, this node opens a short window in which its
// public address serves the relay installer (deploy/relay/install.sh with the
// relay itself embedded), and the command checks that script by SHA-256
// before running it. The script holds nothing secret — the relay creates its
// identity and registration secret itself and prints the relay key, which the
// administrator then adds in the panel (or CLUSTER_RELAY_KEYS).

const APP_ROOT = path.resolve(__dirname, '..', '..');
const MARKER = '__POKYH_RELAY__';
const WINDOW_MS = 30 * 60 * 1000;
export const RELAY_SCRIPT_PATH = '/cluster-relay/v1/install.sh';

let script: { text: string; sha256: string } | null = null;
let windowUntil = 0;

export function relayScript(): { text: string; sha256: string } {
  if (!script) {
    const templatePath = path.join(APP_ROOT, 'deploy/relay/install.sh');
    const relayPath = path.join(APP_ROOT, 'deploy/relay/relay.mjs');
    if (!existsSync(templatePath) || !existsSync(relayPath)) throw new ClusterError('The relay installer is missing from this server\'s build', 500);
    const template = readFileSync(templatePath, 'utf8');
    const relay = readFileSync(relayPath, 'utf8');
    if (!template.includes(MARKER) || relay.includes('POKYH_RELAY_END')) throw new ClusterError('The relay installer template is damaged', 500);
    const text = template.replace(MARKER, relay.trimEnd());
    script = { text, sha256: createHash('sha256').update(text).digest('hex') };
  }
  return script;
}

export interface RelayCommandInput {
  // The public address of this node as the administrator's browser sees it.
  origin: string;
  host: string;
  port: number;
  publicPort: boolean;
  domain: string;
  name: string;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function createRelayCommand(input: RelayCommandInput): { command: string; sha256: string; expiresAt: string } {
  let origin: URL;
  try {
    origin = new URL(input.origin);
  } catch {
    throw new ClusterError('The address of this node is not valid');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) || origin.pathname !== '/' || origin.search || origin.username) {
    throw new ClusterError('Open the admin panel under this node\'s public https address to create the command');
  }
  const host = input.host.trim().toLowerCase();
  const domain = input.domain.trim().toLowerCase();
  if (input.publicPort && !(isServerName(host) || isIP(host) === 4)) throw new ClusterError('Enter the VPS\'s public name or IPv4 address');
  if (domain && !isServerName(domain)) throw new ClusterError('The domain for 443 is not a valid domain name');
  if (!input.publicPort && !domain) throw new ClusterError('Choose the relay\'s own port, 443 through your proxy, or both');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) throw new ClusterError('The port must be between 1 and 65535');
  const name = input.name.replace(/[^A-Za-z0-9 ._-]/g, '').trim().slice(0, 60) || 'relay';

  const built = relayScript();
  windowUntil = Date.now() + WINDOW_MS;
  const args = [
    '--name', quote(name),
    '--port', String(input.port),
    ...(input.publicPort ? ['--public', '--host', quote(host)] : ['--proxy-only']),
    ...(domain ? ['--domain', quote(domain)] : []),
  ];
  const command = [
    `curl -fsSL --proto '=${origin.protocol === 'https:' ? 'https' : 'http'}' -o pokyh-relay.sh ${quote(`${origin.origin}${RELAY_SCRIPT_PATH}`)}`,
    `echo ${quote(`${built.sha256}  pokyh-relay.sh`)} | sha256sum -c -`,
    `sh pokyh-relay.sh ${args.join(' ')}`,
  ].join(' && ');
  return { command, sha256: built.sha256, expiresAt: new Date(windowUntil).toISOString() };
}

export function handleRelayScript(_req: Request, res: Response): void {
  if (Date.now() > windowUntil) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const built = relayScript();
  res.status(200).type('text/plain; charset=utf-8').setHeader('Cache-Control', 'no-store');
  res.send(built.text);
}
