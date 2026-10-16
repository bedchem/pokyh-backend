import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { isSameOrigin } = await loadTs('src/utils/cors.ts');

test('the panel reaching its own server is same-origin under any name', () => {
  assert.equal(isSameOrigin('http://127.0.0.1:4000', '127.0.0.1:4000'), true);
  assert.equal(isSameOrigin('http://localhost:4000', 'localhost:4000'), true);
  assert.equal(isSameOrigin('https://api.pokyh.com', 'API.pokyh.com'), true);
  assert.equal(isSameOrigin('http://192.168.1.20:4000', '192.168.1.20:4000'), true);
});

test('other origins, ports and schemes are not same-origin', () => {
  assert.equal(isSameOrigin('https://evil.example', 'api.pokyh.com'), false);
  assert.equal(isSameOrigin('http://127.0.0.1:5173', '127.0.0.1:4000'), false);
  assert.equal(isSameOrigin('http://api.pokyh.com.evil.example', 'api.pokyh.com'), false);
  assert.equal(isSameOrigin('null', '127.0.0.1:4000'), false);
  assert.equal(isSameOrigin('file:///x', '127.0.0.1:4000'), false);
  assert.equal(isSameOrigin('http://127.0.0.1:4000', undefined), false);
});
