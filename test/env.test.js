const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadEnv } = require('../src/env');

function withDir(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-'));
  for (const [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), buf);
  delete process.env.META_ACCESS_TOKEN;
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true }); delete process.env.META_ACCESS_TOKEN; }
}
const TOKEN = 'EAAQabcdefghijklmnopqrstuvwxyz123';

test('reads a normal .env', () => withDir({ '.env': `META_ACCESS_TOKEN=${TOKEN}\n` }, (d) => {
  assert.equal(loadEnv(d), null);
  assert.equal(process.env.META_ACCESS_TOKEN, TOKEN);
}));

test('reads UTF-16 files written by PowerShell', () => withDir({ '.env': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`META_ACCESS_TOKEN=${TOKEN}\r\n`, 'utf16le')]) }, (d) => {
  assert.equal(loadEnv(d), null);
  assert.equal(process.env.META_ACCESS_TOKEN, TOKEN);
}));

test('accepts .env.txt and a bare token', () => withDir({ '.env.txt': `"${TOKEN}"\r\n` }, (d) => {
  assert.equal(loadEnv(d), null);
  assert.equal(process.env.META_ACCESS_TOKEN, TOKEN);
}));

test('explains a missing file and a missing line', () => {
  withDir({}, (d) => assert.match(loadEnv(d), /No \.env file/));
  withDir({ '.env': 'PORT=3000\n' }, (d) => assert.match(loadEnv(d), /no META_ACCESS_TOKEN/));
  withDir({ '.env': '{\\rtf1\\ansi META_ACCESS_TOKEN=x}' }, (d) => assert.match(loadEnv(d), /rich text/));
});
