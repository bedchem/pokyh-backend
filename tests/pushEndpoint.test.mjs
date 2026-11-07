import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { pushEndpointProblem } = await loadTs('src/utils/pushEndpoint.ts');

test('the browsers\' push services are accepted', () => {
  for (const url of [
    'https://fcm.googleapis.com/fcm/send/abc:APA91b',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAA',
    'https://web.push.apple.com/QGuQyavXutnMH',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
    'https://android.googleapis.com/gcm/send/x',
  ]) {
    assert.equal(pushEndpointProblem(url), null, url);
  }
});

test('anything else is refused: internal addresses, other hosts, other schemes and ports', () => {
  for (const url of [
    'http://fcm.googleapis.com/fcm/send/x',
    'https://10.0.0.5:8080/push',
    'https://127.0.0.1/push',
    'https://localhost/push',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evil.example/fcm.googleapis.com',
    'https://fcm.googleapis.com:8443/x',
    'https://user:pass@fcm.googleapis.com/x',
    'https://notify.windows.com.evil.example/x',
    'file:///etc/passwd',
    'gopher://fcm.googleapis.com/x',
    'not a url',
  ]) {
    assert.notEqual(pushEndpointProblem(url), null, url);
  }
});
