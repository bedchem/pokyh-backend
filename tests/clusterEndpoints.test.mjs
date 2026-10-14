import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const ep = await loadTs('src/cluster/endpoints.ts');
const proxy = await loadTs('src/cluster/proxySnippets.ts');

test('endpoints are https://host:port with an optional server name, nothing else', () => {
  assert.deepEqual(ep.parseEndpoint('https://10.8.0.2:4100'), { url: 'https://10.8.0.2:4100' });
  assert.deepEqual(ep.parseEndpoint('https://vps.example.org:4100?sni=a.pokyh-relay'), { url: 'https://vps.example.org:4100', sni: 'a.pokyh-relay' });
  assert.deepEqual(ep.parseEndpoint('https://a.cluster.example.org:443'), { url: 'https://a.cluster.example.org:443' });
  assert.deepEqual(ep.parseEndpoint('https://A.Cluster.example.org:443?sni=a.cluster.example.org'), { url: 'https://a.cluster.example.org:443' }, 'a server name equal to the host is dropped');
  assert.deepEqual(ep.parseEndpoint('https://[fd00::2]:4100'), { url: 'https://[fd00::2]:4100' });
  for (const bad of [
    'http://10.8.0.2:4100', 'https://10.8.0.2', 'https://user:pw@host:4100', 'https://host:4100/path', 'https://host:4100?x=1',
    'https://host:4100?sni=10.0.0.1', 'https://host:4100?sni=bad_name', 'https://host:4100?sni=a&sni=b', 'https://host:4100#frag', 'not a url', '',
  ]) {
    assert.equal(ep.parseEndpoint(bad), null, bad);
  }
  assert.equal(ep.formatEndpoint({ url: 'https://vps.example.org:4100', sni: 'a.pokyh-relay' }), 'https://vps.example.org:4100?sni=a.pokyh-relay');
});

test('lists keep their order, drop duplicates and report what is unusable', () => {
  const parsed = ep.parseEndpointList('https://10.8.0.2:4100, https://vps.example.org:4100 ,https://10.8.0.2:4100  http://bad:1');
  assert.deepEqual(parsed.endpoints.map(ep.formatEndpoint), ['https://10.8.0.2:4100', 'https://vps.example.org:4100']);
  assert.deepEqual(parsed.invalid, ['http://bad:1']);
  const many = Array.from({ length: 12 }, (_, i) => `https://h${i}.example.org:4100`);
  assert.equal(ep.parseEndpointList(many).endpoints.length, ep.MAX_ENDPOINTS);
  const merged = ep.mergeEndpoints([{ url: 'https://a.example.org:1' }], [{ url: 'https://a.example.org:1' }, { url: 'https://b.example.org:1' }]);
  assert.deepEqual(merged.map(ep.formatEndpoint), ['https://a.example.org:1', 'https://b.example.org:1']);
});

test('the server name presented follows the endpoint', () => {
  assert.deepEqual(ep.connectTarget({ url: 'https://vps.example.org:4100', sni: 'n.pokyh-relay' }), { host: 'vps.example.org', port: 4100, servername: 'n.pokyh-relay' });
  assert.deepEqual(ep.connectTarget({ url: 'https://10.8.0.2:4100' }), { host: '10.8.0.2', port: 4100, servername: undefined }, 'never an IP as server name');
  assert.deepEqual(ep.connectTarget({ url: 'https://[fd00::2]:4100' }), { host: 'fd00::2', port: 4100, servername: undefined });
});

test('public and private addresses are told apart', () => {
  for (const url of ['https://10.8.0.2:4100', 'https://192.168.1.5:4100', 'https://172.20.0.3:4100', 'https://100.64.1.2:4100', 'https://127.0.0.1:4100', 'https://[fd00::2]:4100', 'https://nas.local:4100']) {
    assert.equal(ep.isPublicEndpoint({ url }), false, url);
  }
  for (const url of ['https://203.0.113.10:4100', 'https://vps.example.org:4100', 'https://[2001:db8::1]:4100']) {
    assert.equal(ep.isPublicEndpoint({ url }), true, url);
  }
});

test('curl is told to present the server name while connecting to the relay', () => {
  assert.deepEqual(ep.curlTarget({ url: 'https://vps.example.org:4100', sni: 'n.pokyh-relay' }, '/cluster/v1/install.sh'), {
    url: 'https://n.pokyh-relay:4100/cluster/v1/install.sh',
    connectTo: 'n.pokyh-relay:4100:vps.example.org:4100',
  });
  assert.deepEqual(ep.curlTarget({ url: 'https://a.example.org:443' }, '/x'), { url: 'https://a.example.org:443/x', connectTo: null });
});

test('proxy configuration passes TLS through, by port or by server name', () => {
  const byName = proxy.proxySnippets({ listenPort: 443, serverNames: ['a.cluster.example.org'], backend: '10.8.0.2:4100' });
  assert.match(byName.nginx, /ssl_preread on;/);
  assert.match(byName.nginx, /a\.cluster\.example\.org\s+10\.8\.0\.2:4100;/);
  assert.doesNotMatch(byName.nginx, /ssl_certificate/, 'nginx never terminates TLS here');
  assert.match(byName.haproxy, /req\.ssl_sni -i a\.cluster\.example\.org/);
  assert.match(byName.haproxy, /mode tcp/);
  assert.match(byName.traefik, /HostSNI\(`a\.cluster\.example\.org`\)/);
  assert.match(byName.traefik, /passthrough: true/);
  assert.match(byName.caddy, /tls sni a\.cluster\.example\.org/);

  const wildcard = proxy.proxySnippets({ listenPort: 443, serverNames: ['*.cluster.example.org'], backend: '127.0.0.1:4100' });
  assert.match(wildcard.nginx, /\.cluster\.example\.org\s+127\.0\.0\.1:4100;/);
  assert.match(wildcard.haproxy, /req\.ssl_sni -m end \.cluster\.example\.org/);
  assert.match(wildcard.traefik, /HostSNIRegexp\(`\^\.\+\\\\\.cluster\\\\\.example\\\\\.org\$`\)|HostSNIRegexp\(`\^\.\+\\\.cluster\\\.example\\\.org\$`\)/);

  const byPort = proxy.proxySnippets({ listenPort: 4100, serverNames: [], backend: '10.8.0.2:4100' });
  assert.match(byPort.nginx, /listen 4100;\s+proxy_pass 10\.8\.0\.2:4100;/);
  assert.doesNotMatch(byPort.nginx, /ssl_preread/);
  assert.match(byPort.traefik, /HostSNI\(`\*`\)/);

  assert.equal(proxy.validProxyRoute({ listenPort: 443, serverNames: ['a.example.org'], backend: '10.8.0.2:4100' }), true);
  assert.equal(proxy.validProxyRoute({ listenPort: 443, serverNames: ['a.example.org; evil'], backend: '10.8.0.2:4100' }), false, 'nothing can be injected into the configuration');
  assert.equal(proxy.validProxyRoute({ listenPort: 443, serverNames: [], backend: '10.8.0.2:4100;\n evil' }), false);
});
