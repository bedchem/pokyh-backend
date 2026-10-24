import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { deviceFromRequest, deviceIdFrom, deviceLabel, placeLabel } = await loadTs('src/services/sessionDevice.ts');

const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const EDGE_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68';
const FIREFOX_ANDROID = 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0';
const SAMSUNG = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36';

test('browsers are named with their system and major version', () => {
  assert.deepEqual(deviceFromRequest(CHROME_WIN), { client: 'web', platform: 'windows', os: 'Windows', browser: 'Chrome 130', model: '' });
  assert.deepEqual(deviceFromRequest(SAFARI_IPHONE), { client: 'web', platform: 'ios', os: 'iOS 18.1', browser: 'Safari 18.1', model: '' });
  assert.equal(deviceFromRequest(EDGE_MAC).browser, 'Edge 130');
  assert.equal(deviceFromRequest(EDGE_MAC).os, 'macOS');
  assert.deepEqual(deviceFromRequest(FIREFOX_ANDROID), { client: 'web', platform: 'android', os: 'Android 14', browser: 'Firefox 131', model: '' });
  assert.equal(deviceFromRequest(SAMSUNG).browser, 'Samsung Internet 26');
});

test('the installed website says so in its own header', () => {
  assert.equal(deviceFromRequest(CHROME_WIN, 'pwa').client, 'pwa');
  assert.equal(deviceFromRequest(CHROME_WIN, ['PWA']).client, 'pwa');
  assert.equal(deviceFromRequest(CHROME_WIN, 'something').client, 'web');
});

test('the apps are recognised by their own User-Agent', () => {
  assert.deepEqual(deviceFromRequest('POKYH-Android/2.1.0 (Android 15; samsung SM-S918B)'), {
    client: 'app', platform: 'android', os: 'Android 15', browser: 'POKYH App 2.1.0', model: 'samsung SM-S918B',
  });
  assert.equal(deviceFromRequest('POKYH-iOS/1.4 (iOS 18.1; iPhone15,2)').platform, 'ios');
  // A header claiming to be a browser does not make an app one.
  assert.equal(deviceFromRequest('POKYH-Android/2.1.0', 'pwa').client, 'app');
  // Apps from before they named themselves.
  assert.deepEqual(deviceFromRequest('okhttp/4.12.0'), { client: 'app', platform: 'android', os: 'Android', browser: 'POKYH App', model: '' });
});

test('anything else is "other"', () => {
  assert.equal(deviceFromRequest('node').client, 'other');
  assert.equal(deviceFromRequest(undefined).client, 'other');
  assert.equal(deviceFromRequest('').platform, 'other');
});

test('device ids are accepted only in their own shape', () => {
  assert.equal(deviceIdFrom('a1B2c3D4e5F6g7H8_-xy'), 'a1B2c3D4e5F6g7H8_-xy');
  assert.equal(deviceIdFrom(['0123456789abcdef']), '0123456789abcdef');
  assert.equal(deviceIdFrom('short'), null);
  assert.equal(deviceIdFrom('has spaces in it 1234'), null);
  assert.equal(deviceIdFrom('x'.repeat(65)), null);
  assert.equal(deviceIdFrom(undefined), null);
});

test('labels for the device list', () => {
  assert.equal(deviceLabel({ os: 'Android 15', browser: 'POKYH App 2.1.0', model: 'samsung SM-S918B' }), 'Android 15 (samsung SM-S918B) · POKYH App 2.1.0');
  assert.equal(deviceLabel({ os: 'Windows', browser: 'Chrome 130', model: '' }), 'Windows · Chrome 130');
  assert.equal(deviceLabel({ os: '', browser: '', model: '' }), 'Unbekannt');
  assert.equal(placeLabel({ city: 'Brixen', region: 'Trentino-Südtirol', country: 'IT' }), 'Brixen, Trentino-Südtirol, IT');
  assert.equal(placeLabel({ city: null, region: '', country: 'AT' }), 'AT');
  assert.equal(placeLabel({}), '');
});
