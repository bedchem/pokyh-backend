import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './helpers/loadTs.mjs';

const { readLoginOptions } = await loadTs('src/webuntis/loginOptions.ts');

// The part of WebUntis' page configuration that matters, as WebUntis writes it.
const page = ({ office365 = false, hide = false } = {}) => `<script>var config = {"loginServiceConfig":{"anonymousMode":true,`
  + `"user":{"name":"anonym","id":-1,"personId":-1},"ssoOffice365":${office365},`
  + `"ssoOffice365LoginUrl":${office365 ? '"oauth2/authorization/office365"' : 'null'},"adminEmail":null,`
  + `"hideWuLogin":${hide},"oidcProviderLabel":null,"ssoOidc":false,"ssoSamlProviders":[]}};</script>`;

test('a school with Office 365 offers it next to the password', () => {
  assert.deepEqual(readLoginOptions(page({ office365: true })), { office365: true, password: true });
});

test('a school without it signs in with the password only', () => {
  assert.deepEqual(readLoginOptions(page()), { office365: false, password: true });
});

test('a school that hides the password form signs in with Office 365 only', () => {
  assert.deepEqual(readLoginOptions(page({ office365: true, hide: true })), { office365: true, password: false });
});

test('the password form never goes without another way in', () => {
  assert.deepEqual(readLoginOptions(page({ hide: true })), { office365: false, password: true });
});

test('a page without the configuration has no options', () => {
  assert.equal(readLoginOptions('<html><body>Wartungsarbeiten</body></html>'), null);
  assert.equal(readLoginOptions('{"ssoOffice365Extra":true}'), null);
});
