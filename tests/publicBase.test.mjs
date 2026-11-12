import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { loadTs } from './helpers/loadTs.mjs';

const { requestBase, siteHostsOf, withBase, withPopupPictureBase } = await loadTs('src/utils/publicBase.ts');
const SITE = siteHostsOf('https://example.org, https://www.pokyh.example, http://localhost:3000, *, nonsense');

test('the website origins give the hosts a request may name', () => {
  assert.deepEqual(SITE, ['example.org', 'pokyh.example', 'localhost']);
  assert.deepEqual(siteHostsOf(''), []);
});

test('PUBLIC_BASE_URL wins over the request, without a trailing slash', () => {
  assert.equal(requestBase('https://api.example.org', { secure: false, host: 'evil.test' }, SITE), 'https://api.example.org');
  assert.equal(requestBase('https://api.example.org/', { secure: true, host: 'other.test' }, SITE), 'https://api.example.org');
  assert.equal(requestBase('https://example.org/api//', { secure: true, host: 'api.example.org' }, SITE), 'https://example.org/api');
});

test('a PUBLIC_BASE_URL that is no plain address names none, rather than going into HTML', () => {
  for (const bad of ['https://x" onerror="alert(1)', 'javascript:alert(1)', 'https://user:pw@api.example.org', 'https://api.example.org/?x=1', 'https://api.example.org/#x', 'api.example.org', 'ftp://api.example.org']) {
    const base = requestBase(bad, { secure: true, host: 'api.example.org' }, SITE);
    assert.ok(base === '' || /^https?:\/\/[^"<>\s]+$/.test(base), `${bad} -> ${base}`);
    assert.ok(!base.includes('"') && !base.includes('@') && !base.includes('?') && !base.includes('#'), `${bad} -> ${base}`);
  }
  assert.equal(requestBase('javascript:alert(1)', { secure: true, host: 'api.example.org' }, SITE), '');
});

test('without it, the HTTPS address the request came to, on the website\'s site', () => {
  assert.equal(requestBase('', { secure: true, host: 'API.Example.org' }, SITE), 'https://api.example.org');
  assert.equal(requestBase('', { secure: true, host: 'example.org' }, SITE), 'https://example.org');
  assert.equal(requestBase('', { secure: true, host: 'api.example.org:8443' }, SITE), 'https://api.example.org:8443');
  assert.equal(requestBase('', { secure: true, host: 'api.pokyh.example' }, SITE), 'https://api.pokyh.example', 'www. of an origin left out');
  assert.equal(requestBase('', { secure: true, host: '[2001:db8::1]:443' }, ['[2001:db8::1]']), 'https://[2001:db8::1]:443');
});

test('a host off the site (a proxy\'s upstream, a forged header) gives no address: the path stays', () => {
  for (const host of ['evil.test', 'app-blue:4000', '10.0.0.5:8080', 'example.org.evil.test', 'evilexample.org', 'xexample.org', '[2001:db8::1]']) {
    assert.equal(requestBase('', { secure: true, host }, SITE), '', host);
  }
  assert.equal(requestBase('', { secure: true, host: 'api.example.org' }, []), '', 'no website origin known');
});

test('plain http or a host that is no host gives no address: the path stays', () => {
  assert.equal(requestBase('', { secure: false, host: 'api.example.org' }, SITE), '');
  assert.equal(requestBase('', { secure: true, host: undefined }, SITE), '');
  assert.equal(requestBase('', { secure: true, host: '' }, SITE), '');
  for (const host of ['api.example.org/x', 'a@api.example.org', 'api.example.org?x', 'api.example.org#x', 'a b', 'api.example.org\\x', '-bad.example.org', `${'x'.repeat(300)}.example.org`, 'api.example.org:99999999', '"><script>']) {
    assert.equal(requestBase('', { secure: true, host }, SITE), '', host);
  }
});

test('only paths of this server get the address, links and empty stay', () => {
  const base = 'https://api.example.org';
  assert.equal(withBase('/dishes/abc/image?v=1', base), 'https://api.example.org/dishes/abc/image?v=1');
  assert.equal(withBase('https://cdn.test/x.jpg', base), 'https://cdn.test/x.jpg');
  assert.equal(withBase('//cdn.test/x.jpg', base), '//cdn.test/x.jpg');
  assert.equal(withBase('', base), '');
  assert.equal(withBase('/dishes/abc/image', ''), '/dishes/abc/image');
});

test('a popup\'s pictures get the address, other images and text stay', () => {
  const base = 'https://api.example.org';
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const html = `<p>/popup-images/${id}</p><img src="/popup-images/${id}" alt=""><img src="https://cdn.test/a.png"><img alt="x" src="/popup-images/${id}">`;
  assert.equal(
    withPopupPictureBase(html, base),
    `<p>/popup-images/${id}</p><img src="${base}/popup-images/${id}" alt=""><img src="https://cdn.test/a.png"><img alt="x" src="${base}/popup-images/${id}">`,
  );
  assert.equal(withPopupPictureBase(html, ''), html);
  // A "$" in the address is text, not a replacement pattern.
  assert.equal(withPopupPictureBase(`<img src="/popup-images/${id}">`, 'https://a.test/$1$&'), `<img src="https://a.test/$1$&/popup-images/${id}">`);
});

// What Express hands over for req.secure and req.host, by TRUST_PROXY.
async function addressFor(trustProxy, headers) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.get('/', (req, res) => res.json({ base: requestBase('', req, ['example.org', '127.0.0.1']) }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`, { headers });
    return (await res.json()).base;
  } finally {
    server.close();
  }
}

test('forwarded headers count only when TRUST_PROXY trusts the proxy', async () => {
  const forwarded = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'api.example.org' };
  assert.equal(await addressFor(false, forwarded), '', 'untrusted: the connection is plain http');
  assert.equal(await addressFor(1, forwarded), 'https://api.example.org');
  assert.equal(await addressFor('loopback', { ...forwarded, 'X-Forwarded-Host': 'api.example.org, evil.test' }), 'https://api.example.org');
  // Express takes the first value: a client's own header in front of the proxy's is off the site.
  assert.equal(await addressFor('loopback', { ...forwarded, 'X-Forwarded-Host': 'evil.test, api.example.org' }), '');
  assert.equal(await addressFor(1, { 'X-Forwarded-Proto': 'http', 'X-Forwarded-Host': 'api.example.org' }), '');
  // A proxy that passes the Host on and only says https.
  assert.equal(await addressFor('loopback', { 'X-Forwarded-Proto': 'https' }).then((b) => b.startsWith('https://127.0.0.1:')), true);
});
