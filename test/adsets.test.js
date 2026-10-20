const test = require('node:test');
const assert = require('node:assert');
const { buildAdsetParams, validateNewAdset, copyAdset, toMinorUnits } = require('../src/adsets');

const abo = { id: 'c1', objective: 'OUTCOME_LEADS' };
const cbo = { id: 'c2', objective: 'OUTCOME_TRAFFIC', daily_budget: '5000' };
const input = {
  name: 'Columbus 30-65', dailyBudget: '25', pixelId: 'px1', event: 'LEAD', ageMin: 30, ageMax: 65, gender: 'all',
  locations: [{ type: 'city', key: '2430536', radius: 20 }, { type: 'zip', key: 'US:43215' }],
};

test('leads ad set optimizes for pixel leads with Advantage+ audience off', () => {
  const p = buildAdsetParams(input, abo, 'USD');
  assert.equal(p.optimization_goal, 'OFFSITE_CONVERSIONS');
  assert.deepEqual(p.promoted_object, { pixel_id: 'px1', custom_event_type: 'LEAD' });
  assert.equal(p.daily_budget, 2500);
  assert.equal(p.bid_strategy, 'LOWEST_COST_WITHOUT_CAP');
  assert.equal(p.status, 'PAUSED');
  assert.equal(p.targeting.targeting_automation.advantage_audience, 0);
  assert.deepEqual(p.targeting.geo_locations.cities, [{ key: '2430536', radius: 20, distance_unit: 'mile' }]);
  assert.deepEqual(p.targeting.geo_locations.zips, [{ key: 'US:43215' }]);
  assert.equal(p.targeting.age_min, 30);
  assert.equal(p.targeting.genders, undefined);
});

test('campaign budget campaigns get no ad set budget; manual placements apply', () => {
  const p = buildAdsetParams({ ...input, placements: 'manual', gender: 'female' }, cbo);
  assert.equal(p.daily_budget, undefined);
  assert.equal(p.bid_strategy, undefined);
  assert.equal(p.optimization_goal, 'LINK_CLICKS');
  assert.equal(p.promoted_object, undefined);
  assert.deepEqual(p.targeting.publisher_platforms, ['facebook', 'instagram']);
  assert.deepEqual(p.targeting.genders, [2]);
});

test('special ad categories drop age/gender and enforce a 15 mile radius', () => {
  const p = buildAdsetParams({ ...input, gender: 'male', locations: [{ type: 'city', key: 'x', radius: 5 }] }, { ...abo, special_ad_categories: ['HOUSING'] });
  assert.equal(p.targeting.age_min, undefined);
  assert.equal(p.targeting.genders, undefined);
  assert.equal(p.targeting.geo_locations.cities[0].radius, 15);
});

test('validation explains what is missing', () => {
  const errs = validateNewAdset({ name: '', locations: [] }, abo);
  assert.equal(errs.length, 4);
  assert.match(validateNewAdset({ ...input }, { id: 'c', objective: 'OUTCOME_ENGAGEMENT' })[0], /Copy an existing/);
  assert.deepEqual(validateNewAdset({ ...input, dailyBudget: '' }, cbo), []);
});

test('copy keeps settings, renames and sets budget', async () => {
  const calls = [];
  const client = { async post(path, params) { calls.push([path, params]); return path.endsWith('/copies') ? { copied_adset_id: 'new1' } : { success: true }; } };
  const id = await copyAdset(client, 'src1', { name: 'Copy A', dailyBudget: '40' }, abo, 'USD');
  assert.equal(id, 'new1');
  assert.deepEqual(calls[0], ['src1/copies', { campaign_id: 'c1', deep_copy: false, status_option: 'PAUSED' }]);
  assert.deepEqual(calls[1], ['new1', { name: 'Copy A', daily_budget: 4000 }]);
});

test('budget minor units', () => {
  assert.equal(toMinorUnits('19.99', 'USD'), 1999);
  assert.equal(toMinorUnits('1000', 'JPY'), 1000);
});
