import { BlockList, isIP } from 'net';

// Which addresses may reach the node-to-node channel. Pure logic, testable on
// its own. Entries are single addresses or CIDR ranges, IPv4 or IPv6.

export interface Allowlist {
  list: BlockList | null;
  // Entries that could not be understood; reported, never silently widened.
  invalid: string[];
  size: number;
}

export function parseAllowlist(entries: string[]): Allowlist {
  if (entries.length === 0) return { list: null, invalid: [], size: 0 };
  const list = new BlockList();
  const invalid: string[] = [];
  let size = 0;
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split('/');
    const family = address ? isIP(address) : 0;
    if (!address || family === 0 || extra !== undefined) { invalid.push(entry); continue; }
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) {
      list.addAddress(address, type);
    } else {
      const bits = Number(prefix);
      if (!/^\d{1,3}$/.test(prefix) || bits > (family === 6 ? 128 : 32)) { invalid.push(entry); continue; }
      list.addSubnet(address, bits, type);
    }
    size++;
  }
  // A list that names something but where every entry is unusable must not
  // turn into "everybody may connect".
  return { list: size > 0 || invalid.length > 0 ? list : null, invalid, size };
}

// An IPv4 client reaching an IPv6 socket appears as ::ffff:a.b.c.d.
export function normalizeRemoteAddress(address: string | undefined): string | null {
  if (!address) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped ? mapped[1]! : address;
}

export function isAllowed(allowlist: Allowlist, address: string | undefined): boolean {
  if (!allowlist.list) return true;
  const normalized = normalizeRemoteAddress(address);
  if (!normalized) return false;
  const family = isIP(normalized);
  if (family === 0) return false;
  return allowlist.list.check(normalized, family === 6 ? 'ipv6' : 'ipv4');
}
