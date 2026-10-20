const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.META_ACCESS_TOKEN = 'test-token';
const app = require('../src/server');

// Fake Graph API: records calls, answers like Meta would.
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/v[\d.]+\//, '');
  const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : {};
  calls.push({ method: init.method, path, body });
  const json = (d) => ({ ok: true, status: 200, json: async () => d });
  if (path === 'act_1') return json({ currency: 'USD' });
  if (path === 'camp1') return json({ id: 'camp1', objective: 'OUTCOME_LEADS' });
  if (path === 'src1/copies') return json({ copied_adset_id: 'new2' });
  if (path === 'act_1/adsets' && init.method === 'POST') return json({ id: 'new1' });
  if (/^new\d$/.test(path) && init.method === 'GET') return json({ id: path, name: 'X', status: 'PAUSED', campaign: { id: 'camp1' } });
  return json({ success: true });
};

function post(server, path, data) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(data));
  });
}

test('POST /api/accounts/:id/adsets creates and copies', async (t) => {
  const server = app.listen(0);
  t.after(() => { server.close(); globalThis.fetch = realFetch; });

  const created = await post(server, '/api/accounts/act_1/adsets', {
    mode: 'new', campaignId: 'camp1', name: 'Columbus', dailyBudget: '20', pixelId: 'px', event: 'LEAD',
    locations: [{ type: 'city', key: '123', radius: 15 }], ageMin: 30, ageMax: 65, gender: 'all', placements: 'manual',
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.id, 'new1');
  const createCall = calls.find((c) => c.path === 'act_1/adsets' && c.method === 'POST');
  assert.equal(createCall.body.daily_budget, '2000');
  assert.equal(JSON.parse(createCall.body.targeting).targeting_automation.advantage_audience, 0);

  const copied = await post(server, '/api/accounts/act_1/adsets', { mode: 'copy', campaignId: 'camp1', sourceAdsetId: 'src1', name: 'Columbus copy' });
  assert.equal(copied.body.id, 'new2');
  const copyCall = calls.find((c) => c.path === 'src1/copies');
  assert.equal(copyCall.body.deep_copy, 'false'); // settings only, no ads
  assert.equal(calls.find((c) => c.path === 'new2' && c.method === 'POST').body.name, 'Columbus copy');

  const bad = await post(server, '/api/accounts/act_1/adsets', { mode: 'new', campaignId: 'camp1', name: '', locations: [] });
  assert.equal(bad.status, 400);
});
