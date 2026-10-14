import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadTs } from './helpers/loadTs.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = await loadTs('src/cluster/scopeRules.ts');
const endpoints = await loadTs('src/cluster/endpoints.ts');
const snippets = await loadTs('src/cluster/proxySnippets.ts');
const options = await loadTs('src/cluster/installOptions.ts');
const bootstrap = await import(pathToFileURL(path.join(REPO, 'deploy/node/bootstrap.mjs')).href);
const updater = await import(pathToFileURL(path.join(REPO, 'deploy/node/updater.mjs')).href);

// ─── What is exchanged ───────────────────────────────────────────────────────

test('Pokyh Learn is a group of tables that can be left out of the exchange', () => {
  assert.equal(rules.isLearnTable('learn_courses'), true);
  assert.equal(rules.isLearnTable('LEARN_PROFILES'), true);
  assert.equal(rules.isLearnTable('users'), false);
  assert.equal(rules.isLearnTable('relearn'), false);
  const off = rules.exchangedIn({ learn: false });
  assert.equal(off('learn_vocabulary_entries'), false);
  assert.equal(off('todos'), true);
  assert.equal(off('popups'), true);
  assert.equal(rules.exchangedIn({ learn: true })('learn_vocabulary_entries'), true);
});

test('the newest setting wins everywhere; equal ages are settled the same way on every node', () => {
  const scope = (learn, version, by) => ({ learn, version, by, actor: null });
  assert.equal(rules.supersedes(scope(false, 2000, 'a'), scope(true, 1000, 'b')), true, 'newer');
  assert.equal(rules.supersedes(scope(false, 1000, 'b'), scope(true, 2000, 'a')), false, 'older');
  // Two defaults (version 0) that differ: the higher node id decides, from
  // both sides alike — so both end up with the same value.
  const a = scope(true, 0, 'a');
  const b = scope(false, 0, 'b');
  assert.equal(rules.supersedes(b, a), true);
  assert.equal(rules.supersedes(a, b), false);
  // Saying the same thing again changes nothing.
  assert.equal(rules.supersedes(scope(true, 0, 'z'), scope(true, 0, 'a')), false);
});

test('a restricted catalog keeps its order and fingerprints only what is exchanged', () => {
  const table = (name, rank) => ({ name, rank });
  const lines = ['c|users|id|varchar(36)|NO', 'c|learn_courses|id|varchar(36)|NO', 'u|learn_courses|PRIMARY|id', 'c|todos|id|varchar(36)|NO'];
  const full = {
    ordered: [table('users', 0), table('learn_courses', 1), table('todos', 1)],
    tables: new Map([['users', table('users', 0)], ['learn_courses', table('learn_courses', 1)], ['todos', table('todos', 1)]]),
    signature: lines,
    fingerprint: rules.fingerprintOf(lines),
  };
  assert.equal(rules.restrictCatalog(full, () => true), full, 'nothing left out: the same catalog');
  const core = rules.restrictCatalog(full, rules.exchangedIn({ learn: false }));
  assert.deepEqual(core.ordered.map((entry) => entry.name), ['users', 'todos']);
  assert.equal(core.tables.has('learn_courses'), false);
  assert.notEqual(core.fingerprint, full.fingerprint, 'nodes that exchange different things do not match');
  assert.equal(core.fingerprint, rules.fingerprintOf(['c|todos|id|varchar(36)|NO', 'c|users|id|varchar(36)|NO']));
  assert.equal(rules.fingerprintOf(['b', 'a']), rules.fingerprintOf(['a', 'b']), 'order does not matter');
});

// ─── Ways through the web proxy ──────────────────────────────────────────────

test('a way through the web proxy is a plain https address with an optional path', () => {
  assert.equal(endpoints.parsePathWay('https://api.example.org/cluster-node/homelab/'), 'https://api.example.org/cluster-node/homelab');
  assert.equal(endpoints.parsePathWay('https://api.example.org'), 'https://api.example.org');
  assert.equal(endpoints.parsePathWay('https://api.example.org:8443/x'), 'https://api.example.org:8443/x');
  assert.equal(endpoints.parsePathWay('http://127.0.0.1:4000'), 'http://127.0.0.1:4000', 'plain http on this machine only (tests)');
  for (const bad of [
    'http://api.example.org/x',
    'https://user:pw@api.example.org/x',
    'https://api.example.org/x?y=1',
    'https://api.example.org/x#y',
    'https://api.example.org/a/../b',
    'https://api.example.org/a b',
    'https://api.example.org/a/b/c/d/e',
    'ftp://api.example.org',
    'nonsense',
  ]) {
    assert.equal(endpoints.parsePathWay(bad), null, bad);
  }
});

test('the proxy configuration for a path passes it on without the prefix, with room for the largest message', () => {
  const route = { url: 'https://api.example.org/cluster-node/homelab', backend: '10.8.0.2:4000', maxBodyBytes: 16 * 1024 * 1024 + 131_072, timeoutSeconds: 35 };
  assert.equal(snippets.validPathRoute(route), true);
  assert.equal(snippets.validPathRoute({ ...route, backend: 'evil; rm -rf /' }), false);
  const out = snippets.pathSnippets(route);
  assert.match(out.nginx, /location \/cluster-node\/homelab\/cluster\/ \{/);
  assert.match(out.nginx, /proxy_pass http:\/\/10\.8\.0\.2:4000\/cluster\/;/);
  assert.match(out.nginx, /client_max_body_size 18m;/);
  assert.match(out.nginx, /proxy_read_timeout 35s;/);
  assert.match(out.caddy, /handle_path \/cluster-node\/homelab\/cluster\/\* \{/);
  assert.match(out.caddy, /rewrite \* \/cluster\{path\}/);
  assert.match(out.caddy, /max_size 18MB/);
  assert.match(out.traefik, /PathPrefix\(`\/cluster-node\/homelab\/cluster\/`\)/);
  assert.match(out.traefik, /stripPrefix:/);
  assert.match(out.haproxy, /replace-path/);
  const root = snippets.pathSnippets({ ...route, url: 'https://api.example.org' });
  assert.match(root.nginx, /location \/cluster\/ \{/);
  assert.doesNotMatch(root.traefik, /stripPrefix/);
});

// ─── How an installed server is reached ──────────────────────────────────────

const defaults = { clusterPort: 4100, apiPort: 4000 };

test('install options default to the inviting node and are checked strictly', () => {
  assert.deepEqual(options.normalizeInstallOptions({}, { addressIsDomain: false, defaults }),
    { web: 'none', apiPort: 0, apiBind: '', apiFrom: [], clusterPort: 4100, clusterBind: '', clusterFrom: [] });
  assert.equal(options.normalizeInstallOptions({}, { addressIsDomain: true, defaults }).web, 'domain', 'a domain: own HTTPS unless chosen otherwise');
  const proxied = options.normalizeInstallOptions(
    { web: 'proxy', apiPort: 8081, apiFrom: '10.8.0.1, 10.8.0.0/24', apiBind: '10.8.0.5', clusterPort: 4200, clusterFrom: '10.8.0.0/24', clusterBind: '' },
    { addressIsDomain: false, defaults },
  );
  assert.deepEqual(proxied, { web: 'proxy', apiPort: 8081, apiBind: '10.8.0.5', apiFrom: ['10.8.0.1', '10.8.0.0/24'], clusterPort: 4200, clusterBind: '', clusterFrom: ['10.8.0.0/24'] });
  const refuse = (input, pattern, addressIsDomain = false) => assert.throws(() => options.normalizeInstallOptions(input, { addressIsDomain, defaults }), pattern);
  refuse({ web: 'domain' }, /domain/);
  refuse({ web: 'proxy', apiPort: 4100 }, /differ/);
  refuse({ web: 'proxy', apiFrom: '10.8.0.0/33' }, /not an IP/);
  refuse({ web: 'proxy', apiFrom: 'evil.example.org' }, /not an IP/);
  refuse({ clusterFrom: '1.2.3.4; rm -rf /' }, /not an IP/);
  refuse({ clusterPort: 0 }, /between 1 and 65535/);
  refuse({ clusterPort: 70000 }, /between 1 and 65535/);
  refuse({ web: 'domain', clusterPort: 443 }, /80 and 443/, true);
  refuse({ clusterBind: 'all' }, /IP address/);
  refuse({ clusterFrom: Array.from({ length: 17 }, (_, i) => `10.0.0.${i}`).join(',') }, /at most 16/);
  assert.equal(options.parseSource('2001:db8::/32'), '2001:db8::/32');
  assert.equal(options.parseSource('2001:db8::/129'), null);
});

const token = { url: 'https://node1.example.org:4100', nodeId: 'n', pin: 'p' };
function payloadWith(node) {
  return {
    v: 1, t: Date.now(),
    node: { name: 'Homelab', domain: '', address: '203.0.113.20', withAi: false, acmeEmail: '', web: 'none', apiPort: 0, apiBind: '', apiFrom: [], clusterPort: 4100, clusterBind: '', clusterFrom: [], ...node },
    env: {}, bundle: { sha256: 'a'.repeat(64), bytes: 1 },
    cluster: { url: token.url, nodeId: token.nodeId, name: 'Graz', cert: '', pairingUntil: 1 },
  };
}

test('behind the administrator\'s proxy: the API on the chosen port, the proxy trusted for the client address', () => {
  const payload = payloadWith({ web: 'proxy', apiPort: 8081, apiBind: '10.8.0.5', apiFrom: ['10.8.0.1'], clusterPort: 4200, clusterBind: '10.8.0.5', clusterFrom: ['10.8.0.0/24'] });
  const env = Object.fromEntries(bootstrap.buildEnvFile({ payload, secrets: { mysqlRootPassword: 'pw', clusterSecret: 'cs' }, generatedAt: 'now' })
    .split('\n').filter((line) => /^[A-Z]/.test(line)).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.equal(env.CLUSTER_MTLS_URL, 'https://203.0.113.20:4200', 'the chosen cluster port');
  assert.equal(env.TRUST_PROXY, 'uniquelocal,10.8.0.1');
  const composeEnv = bootstrap.renderComposeEnv({ ai: { enabled: false }, node: payload.node });
  assert.match(composeEnv, /^COMPOSE_PROFILES=blue,gateway$/m);
  assert.match(composeEnv, /^POKYH_API_PORT=8081$/m);
  assert.match(composeEnv, /^POKYH_API_BIND=10\.8\.0\.5$/m);
  assert.match(composeEnv, /^POKYH_CLUSTER_PORT=4200$/m);
  assert.match(composeEnv, /^POKYH_CLUSTER_BIND=10\.8\.0\.5$/m);
  const caddy = bootstrap.renderGatewayCaddyfile({ trusted: ['10.8.0.1'] });
  assert.match(caddy, /trusted_proxies static private_ranges 10\.8\.0\.1/);
  assert.match(caddy, new RegExp(`^:${bootstrap.GATEWAY_PORT} \\{$`, 'm'));
  assert.match(caddy, /health_uri \/readyz/);
  const none = bootstrap.renderComposeEnv({ ai: { enabled: false }, node: payloadWith({}).node });
  assert.match(none, /^COMPOSE_PROFILES=blue$/m);
  assert.match(none, /^POKYH_CLUSTER_BIND=0\.0\.0\.0$/m);
  assert.doesNotMatch(none, /POKYH_API_PORT/);
});

test('the bootstrap refuses options that do not fit', () => {
  const fails = (node) => assert.throws(() => bootstrap.validatePayload(payloadWith(node), token), /unusable/);
  fails({ web: 'tunnel' });
  fails({ web: 'domain', domain: '' });
  fails({ clusterPort: 0 });
  fails({ web: 'proxy', apiPort: 4100, clusterPort: 4100 });
  fails({ apiFrom: ['not-an-ip'] });
  fails({ clusterFrom: '10.0.0.0/8' });
  assert.equal(bootstrap.validSource('10.0.0.0/8'), true);
  assert.equal(bootstrap.validSource('10.0.0.0/40'), false);
});

test('the updater accepts the gateway, and only with its own file', () => {
  const HOME = '/opt/pokyh';
  const gateway = { cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], volumes: [{ type: 'bind', source: `${HOME}/Caddyfile`, target: '/etc/caddy/Caddyfile' }], ports: [{ target: 8080, published: '8081' }] };
  assert.deepEqual(updater.checkComposePolicy({ services: { gateway } }, HOME), []);
  assert.ok(updater.checkComposePolicy({ services: { gateway: { ...gateway, ports: [{ target: 22, published: '22' }] } } }, HOME).some((problem) => /publishes/.test(problem)));
  assert.ok(updater.checkComposePolicy({ services: { gateway: { ...gateway, volumes: [{ type: 'bind', source: `${HOME}/.env`, target: '/x' }] } } }, HOME).some((problem) => /host path/.test(problem)));
});
