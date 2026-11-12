import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Cluster, REPO } from './harness.mjs';

// The address in front of the pictures the server keeps, end to end against
// MySQL 8.4: without PUBLIC_BASE_URL the menu and the popups name a picture
// with the HTTPS address the request came to (as TRUST_PROXY lets it
// through) when it lies on the website's site (CORS_ORIGIN), otherwise and
// over plain http by its path; one request's address never reaches another's
// answer through the shared cache; with PUBLIC_BASE_URL that one always.
// Run: node --test tests/cluster/pictureAddress.e2e.mjs (after a build).
const require = createRequire(import.meta.url);
const sharp = require(path.join(REPO, 'node_modules', 'sharp'));

const cluster = new Cluster();
let node;
let dishId;
let popupPath;

const png = async (seed) => {
  const data = Buffer.alloc(64 * 48 * 3);
  for (let i = 0; i < data.length; i++) data[i] = ((i + seed) * 2654435761 >>> 13) & 255;
  return (await sharp(data, { raw: { width: 64, height: 48, channels: 3 } }).png().toBuffer()).toString('base64');
};
const via = (host, proto = 'https') => ({ 'X-Forwarded-Proto': proto, 'X-Forwarded-Host': host });
const pictureOf = async (headers = {}) => {
  const r = await cluster.request(node, 'GET', '/dishes', { headers });
  assert.equal(r.status, 200, r.text);
  const dish = r.json.menu.dishes.find((d) => d.internalId === dishId);
  assert.ok(dish, `the dish is on the menu: ${r.text.slice(0, 300)}`);
  assert.equal(dish.ownImage, true);
  return { url: dish.imageUrl, cache: r.headers.get('cache-control') };
};
const popupHtml = async (headers = {}) => {
  const r = await cluster.request(node, 'GET', '/popups/active?platform=android&audience=guest', { headers });
  assert.equal(r.status, 200, r.text);
  return r.json.popups.find((p) => p.title === 'Mit Bild').html;
};

before(async () => {
  await cluster.startMysql();
  // Behind a proxy on the same machine, the website on example.test; no
  // PUBLIC_BASE_URL (the harness blanks every variable).
  node = await cluster.addNode('address', { TRUST_PROXY: 'loopback', CORS_ORIGIN: 'https://example.test', MENSA_PULL_INTERVAL_HOURS: '0' });
  await cluster.start(node, { waitForCluster: false });
  // Every dish of the season on the menu, whatever its date.
  const schedule = await cluster.admin(node, 'PUT', '/dishes/schedule', { mode: 'manual', calendar: 'suedtirol' });
  assert.equal(schedule.status, 200, schedule.text);
  const today = new Date().toISOString().slice(0, 10);
  for (const plan of ['summer', 'winter']) {
    const created = await cluster.admin(node, 'POST', '/dishes', { nameDe: `Mit Bild ${plan}`, date: today, plan });
    assert.equal(created.status, 201, created.text);
    const up = await cluster.admin(node, 'PUT', `/dishes/${created.json.id}/image`, { data: await png(plan.length), mimeType: 'image/png' });
    assert.equal(up.status, 200, up.text);
    assert.match(up.json.imageUrl, /^\/dishes\/[^/]+\/image\?v=\d+$/, 'stored by path');
  }
  const menu = (await cluster.request(node, 'GET', '/dishes')).json.menu.dishes;
  dishId = menu.find((d) => d.ownImage)?.internalId;
  assert.ok(dishId, JSON.stringify(menu).slice(0, 300));

  const up = await cluster.admin(node, 'POST', '/popups/images', { data: await png(7), mimeType: 'image/png' });
  assert.equal(up.status, 201, up.text);
  popupPath = up.json.url;
  const popup = await cluster.admin(node, 'POST', '/popups', { title: 'Mit Bild', content: `Hallo\n\n![](${popupPath})`, platform: 'all', audience: 'all', mode: 'once', showCount: 1, startsAt: null, endsAt: null, enabled: true });
  assert.equal(popup.status, 201, popup.text);
}, { timeout: 400_000 });

after(async () => {
  await cluster.teardown();
}, { timeout: 60_000 });

test('over plain http a picture stays a path: no http:// address is ever handed out', async () => {
  const plain = await pictureOf();
  assert.match(plain.url, new RegExp(`^/dishes/${dishId}/image\\?v=\\d+$`));
  assert.match(plain.cache, /^private\b/, 'never kept by a shared cache');
  assert.match((await pictureOf(via('api.example.test', 'http'))).url, /^\/dishes\//);
  assert.ok((await popupHtml()).includes(`src="${popupPath}"`));
});

test('over HTTPS through the proxy the menu names the address the request came to', async () => {
  const shown = await pictureOf(via('api.example.test'));
  assert.match(shown.url, new RegExp(`^https://api\\.example\\.test/dishes/${dishId}/image\\?v=\\d+$`));
  // The picture really lies behind that path.
  const res = await fetch(`${node.url}${new URL(shown.url).pathname}${new URL(shown.url).search}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp');
  assert.ok((await popupHtml(via('api.example.test'))).includes(`src="https://api.example.test${popupPath}"`));
});

test('a host off the website\'s site is never named: a forged header, a proxy\'s upstream', async () => {
  for (const host of ['evil.example', 'evil.example, api.example.test', 'app-blue:4000', '10.0.0.5:8080', 'example.test.evil.example', 'evil.example/x?']) {
    assert.match((await pictureOf(via(host))).url, /^\/dishes\//, host);
    assert.ok((await popupHtml(via(host))).includes(`src="${popupPath}"`), host);
  }
});

test('one request\'s address never reaches another\'s answer (shared cache)', async () => {
  // The cache filled by one host, then asked with another and with none.
  assert.match((await pictureOf(via('www.example.test'))).url, /^https:\/\/www\.example\.test\//);
  assert.match((await pictureOf()).url, /^\/dishes\//);
  assert.match((await pictureOf(via('api.example.test'))).url, /^https:\/\/api\.example\.test\//);
  assert.ok((await popupHtml(via('www.example.test'))).includes('https://www.example.test/popup-images/'));
  assert.ok((await popupHtml()).includes(`src="${popupPath}"`));
});

test('PUBLIC_BASE_URL, when set, is always the address', async () => {
  await cluster.stop(node);
  node.overrides.PUBLIC_BASE_URL = 'https://pictures.example.org/';
  await cluster.start(node, { waitForCluster: false });
  for (const headers of [{}, via('evil.example')]) {
    assert.match((await pictureOf(headers)).url, new RegExp(`^https://pictures\\.example\\.org/dishes/${dishId}/image\\?v=\\d+$`));
    assert.ok((await popupHtml(headers)).includes(`src="https://pictures.example.org${popupPath}"`));
  }
});
