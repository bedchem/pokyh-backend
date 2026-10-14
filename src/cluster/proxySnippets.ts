// Configuration for a reverse proxy that carries the cluster channel to a node
// (or to a Pokyh relay) — shown in the admin panel. Pure, tested on its own
// (tests/clusterEndpoints).
//
// Whatever the proxy, the requirement is the same: pass the TCP connection on
// unchanged, never terminate TLS (the nodes authenticate each other by their
// own certificates end to end) — either everything arriving on a port of its
// own, or, on a port shared with web traffic such as 443, the connections
// whose TLS server name (SNI) matches.

export interface ProxyRoute {
  // Port the proxy listens on for this traffic.
  listenPort: number;
  // Server names to match; empty: everything on that port. A leading "*."
  // matches every name below that domain.
  serverNames: string[];
  // Where to pass the connections: host:port as the proxy reaches it.
  backend: string;
}

export interface ProxySnippets {
  nginx: string;
  haproxy: string;
  traefik: string;
  caddy: string;
}

const NAME = /^(\*\.)?(?=.{1,253}$)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*$/;
const BACKEND = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]{1,253}):\d{1,5}$/;

export function validProxyRoute(route: ProxyRoute): boolean {
  return Number.isInteger(route.listenPort) && route.listenPort > 0 && route.listenPort < 65_536
    && route.serverNames.every((name) => NAME.test(name)) && BACKEND.test(route.backend);
}

function regexFor(name: string): string {
  const escaped = name.replace(/^\*\./, '').replace(/\./g, '\\.');
  return name.startsWith('*.') ? `^.+\\.${escaped}$` : `^${escaped}$`;
}

function nginx(route: ProxyRoute): string {
  if (route.serverNames.length === 0) {
    return [
      '# nginx.conf, top level (needs the stream module)',
      'stream {',
      '    server {',
      `        listen ${route.listenPort};`,
      `        proxy_pass ${route.backend};`,
      '    }',
      '}',
    ].join('\n');
  }
  const entries = route.serverNames.map((name) => `        ${name.startsWith('*.') ? name.slice(1) : name}    ${route.backend};`);
  return [
    '# nginx.conf, top level (needs the stream module). Your web server then',
    `# listens on another port, e.g. 127.0.0.1:8443, and receives everything else.`,
    'stream {',
    '    map $ssl_preread_server_name $pokyh_target {',
    '        hostnames;',
    ...entries,
    '        default    127.0.0.1:8443;',
    '    }',
    '    server {',
    `        listen ${route.listenPort};`,
    '        ssl_preread on;',
    '        proxy_pass $pokyh_target;',
    '    }',
    '}',
  ].join('\n');
}

function haproxy(route: ProxyRoute): string {
  const lines = [
    'frontend pokyh_cluster',
    `    bind :${route.listenPort}`,
    '    mode tcp',
  ];
  if (route.serverNames.length === 0) {
    lines.push('    default_backend pokyh_node');
  } else {
    lines.push('    tcp-request inspect-delay 5s', '    tcp-request content accept if { req_ssl_hello_type 1 }');
    for (const name of route.serverNames) {
      lines.push(name.startsWith('*.')
        ? `    use_backend pokyh_node if { req.ssl_sni -m end ${name.slice(1)} }`
        : `    use_backend pokyh_node if { req.ssl_sni -i ${name} }`);
    }
    lines.push('    default_backend web   # your existing web backend');
  }
  lines.push('', 'backend pokyh_node', '    mode tcp', `    server node ${route.backend}`);
  return lines.join('\n');
}

function traefik(route: ProxyRoute): string {
  const rule = route.serverNames.length === 0
    ? 'HostSNI(`*`)'
    : route.serverNames.map((name) => (name.startsWith('*.') ? `HostSNIRegexp(\`${regexFor(name)}\`)` : `HostSNI(\`${name}\`)`)).join(' || ');
  return [
    '# Dynamic configuration (file provider). The entry point must listen on',
    `# :${route.listenPort} (for 443: your existing "websecure" entry point).`,
    'tcp:',
    '  routers:',
    '    pokyh-cluster:',
    `      entryPoints: [${route.listenPort === 443 ? 'websecure' : 'pokyh-cluster'}]`,
    `      rule: "${rule}"`,
    '      service: pokyh-cluster',
    '      tls:',
    '        passthrough: true',
    '  services:',
    '    pokyh-cluster:',
    '      loadBalancer:',
    '        servers:',
    `          - address: "${route.backend}"`,
  ].join('\n');
}

function caddy(route: ProxyRoute): string {
  const matcher = route.serverNames.length === 0 ? null : `@pokyh tls sni ${route.serverNames.join(' ')}`;
  return [
    '# Caddyfile global options; needs Caddy built with the layer4 module',
    '# (github.com/mholt/caddy-l4).',
    '{',
    '\tlayer4 {',
    `\t\t:${route.listenPort} {`,
    ...(matcher
      ? [
          `\t\t\t${matcher}`,
          '\t\t\troute @pokyh {',
          `\t\t\t\tproxy ${route.backend}`,
          '\t\t\t}',
          '\t\t\troute {',
          '\t\t\t\tproxy localhost:8443  # your sites, served on another port',
          '\t\t\t}',
        ]
      : [
          '\t\t\troute {',
          `\t\t\t\tproxy ${route.backend}`,
          '\t\t\t}',
        ]),
    '\t\t}',
    '\t}',
    '}',
  ].join('\n');
}

export function proxySnippets(route: ProxyRoute): ProxySnippets {
  return { nginx: nginx(route), haproxy: haproxy(route), traefik: traefik(route), caddy: caddy(route) };
}

// ─── Through the web proxy, by path ──────────────────────────────────────────
// For a way of kind "proxy-path": the proxy serves the API's public name with
// its own certificate, as it does anyway, and passes one path prefix on —
// prefix removed — to this node's cluster entry (its API port with
// CLUSTER_PUBLIC_PATH, or CLUSTER_PORT). Plain HTTP behind the proxy is fine:
// what travels there is sealed end to end.

export interface PathRoute {
  // The way as the other nodes use it: https://api.example.org/cluster-node/a
  url: string;
  // Where the proxy passes it: host:port as the proxy reaches the node.
  backend: string;
  // The largest request and answer the cluster sends, and how long one may take.
  maxBodyBytes: number;
  timeoutSeconds: number;
}

export function validPathRoute(route: PathRoute): boolean {
  return BACKEND.test(route.backend) && Number.isInteger(route.maxBodyBytes) && route.maxBodyBytes > 0
    && Number.isInteger(route.timeoutSeconds) && route.timeoutSeconds > 0;
}

export function pathSnippets(route: PathRoute): ProxySnippets {
  const url = new URL(route.url);
  const host = url.hostname;
  const prefix = url.pathname === '/' ? '' : url.pathname;
  const location = `${prefix}/cluster/`;
  const megabytes = Math.ceil(route.maxBodyBytes / (1024 * 1024)) + 1;
  const nginxConf = [
    `# Inside the existing "server { server_name ${host}; … }" block (http, TLS as for the API).`,
    `location ${location} {`,
    `    proxy_pass http://${route.backend}/cluster/;`,
    '    proxy_http_version 1.1;',
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '    proxy_set_header X-Forwarded-Proto $scheme;',
    `    client_max_body_size ${megabytes}m;`,
    '    proxy_request_buffering off;',
    `    proxy_read_timeout ${route.timeoutSeconds}s;`,
    `    proxy_send_timeout ${route.timeoutSeconds}s;`,
    '}',
  ].join('\n');
  const haproxyConf = [
    '# In the frontend that serves the API over HTTPS (mode http).',
    `acl pokyh_cluster_path path_beg ${location}`,
    'use_backend pokyh_cluster if pokyh_cluster_path',
    '',
    'backend pokyh_cluster',
    '    mode http',
    `    timeout server ${route.timeoutSeconds}s`,
    ...(prefix ? [`    http-request replace-path ^${prefix.replace(/[.]/g, '\\.')}(/cluster/.*) \\1`] : []),
    `    server node ${route.backend}`,
  ].join('\n');
  const traefikConf = [
    '# Dynamic configuration (file provider). The certificate of the API name',
    '# is used as for the API itself.',
    'http:',
    '  routers:',
    '    pokyh-cluster:',
    '      entryPoints: [websecure]',
    `      rule: "Host(\`${host}\`) && PathPrefix(\`${location}\`)"`,
    ...(prefix ? ['      middlewares: [pokyh-cluster-strip]'] : []),
    '      service: pokyh-cluster',
    '      tls: {}',
    ...(prefix ? ['  middlewares:', '    pokyh-cluster-strip:', '      stripPrefix:', `        prefixes: ["${prefix}"]`] : []),
    '  services:',
    '    pokyh-cluster:',
    '      loadBalancer:',
    '        servers:',
    `          - url: "http://${route.backend}"`,
  ].join('\n');
  const caddyConf = [
    `# Inside the existing "${host} { … }" site block.`,
    `${prefix ? 'handle_path' : 'handle'} ${prefix}/cluster/* {`,
    ...(prefix ? ['\trewrite * /cluster{path}'] : []),
    '\trequest_body {',
    `\t\tmax_size ${megabytes}MB`,
    '\t}',
    `\treverse_proxy ${route.backend} {`,
    '\t\ttransport http {',
    `\t\t\tread_timeout ${route.timeoutSeconds}s`,
    `\t\t\twrite_timeout ${route.timeoutSeconds}s`,
    '\t\t}',
    '\t}',
    '}',
  ].join('\n');
  return { nginx: nginxConf, haproxy: haproxyConf, traefik: traefikConf, caddy: caddyConf };
}
