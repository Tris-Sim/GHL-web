const test = require('node:test');
const assert = require('node:assert');
const { buildRows, resultSpec } = require('../src/insights');

const adsets = [
  { id: 's1', name: 'Homeowners', campaign_id: 'c1', effective_status: 'ACTIVE', daily_budget: '2500', optimization_goal: 'OFFSITE_CONVERSIONS', promoted_object: { pixel_id: 'p', custom_event_type: 'LEAD' } },
  { id: 's2', name: 'Broad', campaign_id: 'c1', effective_status: 'PAUSED', optimization_goal: 'OFFSITE_CONVERSIONS', promoted_object: { pixel_id: 'p', custom_event_type: 'LEAD' } },
];
const campaigns = [{ id: 'c1', name: 'Leads', effective_status: 'ACTIVE', daily_budget: '5000' }];
const row = {
  campaign_id: 'c1', campaign_name: 'Leads', adset_id: 's1', adset_name: 'Homeowners',
  spend: '100', impressions: '10000', reach: '5000', inline_link_clicks: '200', unique_clicks: '250',
  unique_link_clicks_ctr: '3.5', unique_outbound_clicks: [{ action_type: 'outbound_click', value: '150' }],
  unique_outbound_clicks_ctr: [{ action_type: 'outbound_click', value: '3' }],
  video_thruplay_watched_actions: [{ action_type: 'video_view', value: '800' }],
  actions: [
    { action_type: 'link_click', value: '200' }, { action_type: 'landing_page_view', value: '160' },
    { action_type: 'offsite_conversion.fb_pixel_lead', value: '10' }, { action_type: 'video_view', value: '3000' },
    { action_type: 'post_engagement', value: '3300' }, { action_type: 'omni_lead', value: '10' },
  ],
};

test('ad set row matches the Tristen performance columns', () => {
  const { rows, total } = buildRows('adset', [row], { campaigns, adsets }, row);
  const r = rows.find((x) => x.id === 's1');
  const m = r.metrics;
  assert.equal(r.delivery, 'ACTIVE');
  assert.deepEqual(r.budget, { amount: 2500, period: 'daily' });
  assert.equal(r.resultLabel, 'Leads');
  assert.equal(m.spend, 100);
  assert.equal(m.results, 10);
  assert.equal(m.costPerResult, 10);
  assert.equal(m.cpm, 10);
  assert.equal(m.frequency, 2);
  assert.equal(m.linkClicks, 200);
  assert.equal(m.costPer1kReached, 20);
  assert.equal(m.uniqueOutboundCtr, 3);
  assert.equal(m.uniqueLinkCtr, 3.5);
  assert.equal(m.costPerUniqueClick, 0.4);
  assert.ok(Math.abs(m.costPerUniqueOutbound - 0.6667) < 0.001);
  assert.equal(m.costPerLpv, 0.625);
  assert.equal(m.hookRate, 30);
  assert.equal(m.holdRate, 8);
  assert.equal(m.actions, 3370); // post_engagement and omni_ duplicates not counted
  // Paused ad set with no delivery still shows, using the campaign budget
  const s2 = rows.find((x) => x.id === 's2');
  assert.ok(s2.noDelivery);
  assert.equal(s2.metrics.spend, 0);
  assert.equal(total.metrics.results, 10);
  assert.equal(total.resultLabel, 'Leads');
});

test('ad set using campaign budget is labelled as such', () => {
  const { rows } = buildRows('adset', [{ ...row, adset_id: 's2', adset_name: 'Broad' }], { campaigns, adsets }, null);
  assert.deepEqual(rows.find((x) => x.id === 's2').budget, { amount: 5000, period: 'daily', campaign: true });
});

test('result types by optimization goal', () => {
  assert.equal(resultSpec({ optimization_goal: 'LINK_CLICKS' }).label, 'Link clicks');
  assert.equal(resultSpec({ optimization_goal: 'OFFSITE_CONVERSIONS', promoted_object: { custom_conversion_id: '42' } }).types[0], 'offsite_conversion.custom.42');
  assert.equal(resultSpec({ optimization_goal: 'SOMETHING_NEW' }), null);
});
