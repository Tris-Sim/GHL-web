// "Tristen performance" columns: pulls Meta insights at the chosen level and
// turns them into the same metrics as the Ads Manager column preset.

const INSIGHT_FIELDS = [
  'account_id', 'account_name', 'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name',
  'spend', 'impressions', 'reach', 'frequency', 'cpm', 'cpp', 'inline_link_clicks',
  'unique_clicks', 'cost_per_unique_click', 'unique_link_clicks_ctr',
  'unique_outbound_clicks', 'unique_outbound_clicks_ctr', 'cost_per_unique_outbound_click',
  'actions', 'video_thruplay_watched_actions',
].join(',');

const LEVELS = {
  account: { id: 'account_id', name: 'account_name' },
  campaign: { id: 'campaign_id', name: 'campaign_name' },
  adset: { id: 'adset_id', name: 'adset_name' },
  ad: { id: 'ad_id', name: 'ad_name' },
};

const DATE_PRESETS = ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month', 'maximum'];

// Action types that count as a "result", by ad set optimization goal. The
// first type present in the row wins (Meta reports some events under
// different names depending on how they were set up).
const PIXEL_EVENTS = {
  LEAD: ['offsite_conversion.fb_pixel_lead', 'lead'],
  PURCHASE: ['offsite_conversion.fb_pixel_purchase', 'purchase'],
  COMPLETE_REGISTRATION: ['offsite_conversion.fb_pixel_complete_registration', 'complete_registration'],
  ADD_TO_CART: ['offsite_conversion.fb_pixel_add_to_cart', 'add_to_cart'],
  INITIATED_CHECKOUT: ['offsite_conversion.fb_pixel_initiate_checkout', 'initiate_checkout'],
  CONTACT: ['contact_total', 'contact_website', 'offsite_conversion.fb_pixel_custom'],
  SCHEDULE: ['schedule_total', 'schedule_website', 'offsite_conversion.fb_pixel_custom'],
  SUBMIT_APPLICATION: ['submit_application_total', 'submit_application_website', 'offsite_conversion.fb_pixel_custom'],
};
const GOAL_RESULTS = {
  LEAD_GENERATION: ['onsite_conversion.lead_grouped', 'lead'],
  QUALITY_LEAD: ['onsite_conversion.lead_grouped', 'lead'],
  LINK_CLICKS: ['link_click'],
  LANDING_PAGE_VIEWS: ['landing_page_view'],
  POST_ENGAGEMENT: ['post_engagement'],
  CONVERSATIONS: ['onsite_conversion.messaging_conversation_started_7d'],
  THRUPLAY: ['__thruplay'],
  REACH: ['__reach'],
  IMPRESSIONS: ['__impressions'],
};
const RESULT_LABELS = {
  LEAD: 'Leads', PURCHASE: 'Purchases', COMPLETE_REGISTRATION: 'Registrations', ADD_TO_CART: 'Adds to cart',
  INITIATED_CHECKOUT: 'Checkouts', CONTACT: 'Contacts', SCHEDULE: 'Schedules', SUBMIT_APPLICATION: 'Applications',
  LEAD_GENERATION: 'Leads', QUALITY_LEAD: 'Leads', LINK_CLICKS: 'Link clicks', LANDING_PAGE_VIEWS: 'Landing page views',
  POST_ENGAGEMENT: 'Engagements', CONVERSATIONS: 'Conversations', THRUPLAY: 'ThruPlays', REACH: 'Reach', IMPRESSIONS: 'Impressions',
};

// Aggregates and duplicates Meta includes in `actions` that would double count.
const NOT_COUNTED = /^(omni_|onsite_web_|web_app_in_store_)|^(post_engagement|page_engagement)$/;

const num = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v));
const actionValue = (list, type) => num((list || []).find((a) => a.action_type === type)?.value);
// Some insight fields come back as [{ action_type, value }] lists.
const listValue = (v) => (Array.isArray(v) ? num(v[0]?.value) : num(v));
const per = (a, b) => (b ? a / b : null);

// What counts as a result for an ad set: { label, types }.
function resultSpec(adset) {
  if (!adset) return null;
  const goal = adset.optimization_goal;
  const po = adset.promoted_object || {};
  if (goal === 'OFFSITE_CONVERSIONS' || goal === 'VALUE') {
    if (po.custom_conversion_id) return { label: 'Conversions', types: [`offsite_conversion.custom.${po.custom_conversion_id}`] };
    const types = PIXEL_EVENTS[po.custom_event_type];
    return types ? { label: RESULT_LABELS[po.custom_event_type], types } : null;
  }
  return GOAL_RESULTS[goal] ? { label: RESULT_LABELS[goal], types: GOAL_RESULTS[goal] } : null;
}

function countResults(row, spec) {
  if (!spec) return null;
  for (const t of spec.types) {
    if (t === '__reach') return num(row.reach);
    if (t === '__impressions') return num(row.impressions);
    if (t === '__thruplay') return listValue(row.video_thruplay_watched_actions);
    const v = actionValue(row.actions, t);
    if (v) return v;
  }
  return 0;
}

// The raw, additive numbers behind a row; totals are built by summing these.
function rawFromInsight(row, spec) {
  return {
    spend: num(row.spend),
    impressions: num(row.impressions),
    reach: num(row.reach),
    linkClicks: num(row.inline_link_clicks),
    uniqueClicks: num(row.unique_clicks),
    uniqueOutbound: listValue(row.unique_outbound_clicks),
    landingPageViews: actionValue(row.actions, 'landing_page_view'),
    videoViews3s: actionValue(row.actions, 'video_view'),
    thruplays: listValue(row.video_thruplay_watched_actions),
    actions: (row.actions || []).filter((a) => !NOT_COUNTED.test(a.action_type)).reduce((s, a) => s + num(a.value), 0),
    results: countResults(row, spec),
    // Unique CTRs aren't additive, so keep Meta's own value for single rows.
    uniqueLinkCtr: row.unique_link_clicks_ctr !== undefined ? num(row.unique_link_clicks_ctr) : null,
    uniqueOutboundCtr: row.unique_outbound_clicks_ctr !== undefined ? listValue(row.unique_outbound_clicks_ctr) : null,
  };
}

// Derived metrics, computed the way Ads Manager defines them.
function metrics(raw) {
  return {
    spend: raw.spend,
    actions: raw.actions,
    cpm: per(raw.spend * 1000, raw.impressions),
    frequency: per(raw.impressions, raw.reach),
    linkClicks: raw.linkClicks,
    results: raw.results,
    costPerResult: raw.results ? raw.spend / raw.results : null,
    costPer1kReached: per(raw.spend * 1000, raw.reach),
    uniqueOutboundCtr: raw.uniqueOutboundCtr ?? (per(raw.uniqueOutbound * 100, raw.reach)),
    uniqueLinkCtr: raw.uniqueLinkCtr,
    costPerUniqueClick: per(raw.spend, raw.uniqueClicks),
    costPerUniqueOutbound: per(raw.spend, raw.uniqueOutbound),
    costPerLpv: per(raw.spend, raw.landingPageViews),
    hookRate: raw.videoViews3s ? per(raw.videoViews3s * 100, raw.impressions) : null,
    holdRate: raw.videoViews3s ? per(raw.thruplays * 100, raw.videoViews3s) : null,
    impressions: raw.impressions,
    reach: raw.reach,
  };
}

const budgetOf = (o) => (o && (Number(o.daily_budget) || Number(o.lifetime_budget))
  ? { amount: Number(o.daily_budget || o.lifetime_budget), period: o.daily_budget ? 'daily' : 'lifetime' }
  : null);

/**
 * Builds the table for one account.
 * objects: { campaigns, adsets, ads } as returned by Meta (with status/budget/goal fields).
 * Returns { rows, total } where every row has { id, name, parent, delivery, budget, raw, metrics }.
 */
function buildRows(level, insights, objects, accountTotal) {
  const key = LEVELS[level];
  const campaigns = new Map((objects.campaigns || []).map((c) => [c.id, c]));
  const adsets = new Map((objects.adsets || []).map((s) => [s.id, s]));
  const ads = new Map((objects.ads || []).map((a) => [a.id, a]));

  // A campaign's result type is only defined when all its ad sets agree.
  const campaignSpec = (campaignId) => {
    const specs = [...adsets.values()].filter((s) => s.campaign_id === campaignId).map(resultSpec).filter(Boolean);
    const labels = new Set(specs.map((s) => s.label));
    return labels.size === 1 ? { label: specs[0].label, types: [...new Set(specs.flatMap((s) => s.types))] } : null;
  };
  const specFor = (row) => {
    if (level === 'ad') return resultSpec(adsets.get(row.adset_id));
    if (level === 'adset') return resultSpec(adsets.get(row.adset_id));
    if (level === 'campaign') return campaignSpec(row.campaign_id);
    return null;
  };

  const describe = (id, row) => {
    if (level === 'campaign') {
      const c = campaigns.get(id);
      return { delivery: c?.effective_status, budget: budgetOf(c), parent: null };
    }
    if (level === 'adset') {
      const s = adsets.get(id);
      const c = campaigns.get(s?.campaign_id || row?.campaign_id);
      return { delivery: s?.effective_status, budget: budgetOf(s) || (budgetOf(c) ? { ...budgetOf(c), campaign: true } : null), parent: row?.campaign_name || c?.name };
    }
    if (level === 'ad') {
      const a = ads.get(id);
      const s = adsets.get(a?.adset_id || row?.adset_id);
      return { delivery: a?.effective_status, budget: budgetOf(s), parent: [row?.campaign_name, row?.adset_name || s?.name].filter(Boolean).join(' › ') };
    }
    return { delivery: null, budget: null, parent: null };
  };

  const rows = insights.map((r) => {
    const spec = specFor(r);
    const raw = rawFromInsight(r, spec);
    return { id: r[key.id], name: r[key.name], campaignId: r.campaign_id, adsetId: r.adset_id, ...describe(r[key.id], r), resultLabel: spec?.label || null, raw, metrics: metrics(raw) };
  });

  // Objects that didn't deliver in the date range still get a row.
  const seen = new Set(rows.map((r) => r.id));
  const source = level === 'campaign' ? campaigns : level === 'adset' ? adsets : level === 'ad' ? ads : new Map();
  for (const [id, o] of source) {
    if (seen.has(id)) continue;
    const raw = rawFromInsight({}, null);
    raw.results = null;
    const parent = level === 'adset' ? campaigns.get(o.campaign_id)?.name : level === 'ad' ? [campaigns.get(adsets.get(o.adset_id)?.campaign_id)?.name, adsets.get(o.adset_id)?.name].filter(Boolean).join(' › ') : null;
    const campaignId = level === 'campaign' ? id : level === 'adset' ? o.campaign_id : adsets.get(o.adset_id)?.campaign_id;
    const adsetId = level === 'adset' ? id : o.adset_id;
    rows.push({ id, name: o.name, campaignId, adsetId, ...describe(id, null), parent, resultLabel: null, raw, metrics: metrics(raw), noDelivery: true });
  }

  let total = null;
  if (accountTotal) {
    const raw = rawFromInsight(accountTotal, null);
    // Results only add up when every row counts the same kind of result.
    const labels = new Set(rows.filter((r) => r.raw.results).map((r) => r.resultLabel));
    raw.results = labels.size === 1 ? rows.reduce((s, r) => s + (r.raw.results || 0), 0) : null;
    total = { raw, metrics: metrics(raw), resultLabel: labels.size === 1 ? [...labels][0] : null };
  }
  return { rows, total };
}

module.exports = { INSIGHT_FIELDS, LEVELS, DATE_PRESETS, resultSpec, rawFromInsight, metrics, buildRows };
