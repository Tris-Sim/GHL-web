// Creates ad sets: either a copy of an existing ad set (keeps its audience,
// optimization and pixel) or a new one built from a small form.

// What a from-scratch ad set optimizes for, by campaign objective.
// Objectives not listed here can only be created by copying an existing ad set.
const GOALS = {
  OUTCOME_LEADS: { optimization_goal: 'OFFSITE_CONVERSIONS', destination_type: 'WEBSITE', event: 'LEAD', pixel: true },
  OUTCOME_SALES: { optimization_goal: 'OFFSITE_CONVERSIONS', destination_type: 'WEBSITE', event: 'PURCHASE', pixel: true },
  CONVERSIONS: { optimization_goal: 'OFFSITE_CONVERSIONS', event: 'LEAD', pixel: true },
  OUTCOME_TRAFFIC: { optimization_goal: 'LINK_CLICKS', destination_type: 'WEBSITE' },
  LINK_CLICKS: { optimization_goal: 'LINK_CLICKS' },
  OUTCOME_AWARENESS: { optimization_goal: 'REACH' },
  REACH: { optimization_goal: 'REACH' },
};

const CONVERSION_EVENTS = ['LEAD', 'COMPLETE_REGISTRATION', 'CONTACT', 'SCHEDULE', 'SUBMIT_APPLICATION', 'PURCHASE', 'INITIATED_CHECKOUT', 'ADD_TO_CART'];

// Meta takes budgets in the currency's smallest unit (cents for USD).
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD', 'COP', 'IDR', 'PYG']);
const toMinorUnits = (amount, currency) => Math.round(Number(amount) * (ZERO_DECIMAL.has(currency) ? 1 : 100));

const isCbo = (campaign) => Boolean(Number(campaign.daily_budget) || Number(campaign.lifetime_budget));
const isSpecialCategory = (campaign) => (campaign.special_ad_categories || []).some((c) => c && c !== 'NONE');

const MANUAL_PLACEMENTS = {
  publisher_platforms: ['facebook', 'instagram'],
  facebook_positions: ['feed', 'story', 'facebook_reels', 'video_feeds', 'marketplace'],
  instagram_positions: ['stream', 'story', 'reels', 'explore'],
};

function validateNewAdset(input, campaign) {
  const errs = [];
  const goal = GOALS[campaign.objective];
  if (!input.name || !input.name.trim()) errs.push('Give the ad set a name.');
  if (!goal) errs.push(`Campaigns with the ${campaign.objective} objective can't get a new ad set from scratch here. Copy an existing ad set instead.`);
  if (!isCbo(campaign) && !(Number(input.dailyBudget) > 0)) errs.push('Set a daily budget (this campaign has no campaign budget).');
  if (goal && goal.pixel && !input.pixelId) errs.push('Pick the pixel to track conversions with.');
  if (!(input.locations || []).length) errs.push('Add at least one location.');
  return errs;
}

function buildGeo(locations, special) {
  const geo = { location_types: ['home', 'recent'] };
  for (const l of locations) {
    if (l.type === 'country') (geo.countries ||= []).push(l.key);
    else if (l.type === 'region') (geo.regions ||= []).push({ key: l.key });
    else if (l.type === 'zip') (geo.zips ||= []).push({ key: l.key });
    else if (l.type === 'city') {
      // Housing / employment / credit ads need at least a 15 mile radius.
      const radius = Math.max(Number(l.radius) || 0, special ? 15 : 0) || undefined;
      (geo.cities ||= []).push(radius ? { key: l.key, radius, distance_unit: 'mile' } : { key: l.key });
    }
  }
  return geo;
}

function buildAdsetParams(input, campaign, currency = 'USD') {
  const goal = GOALS[campaign.objective];
  const special = isSpecialCategory(campaign);
  const targeting = {
    geo_locations: buildGeo(input.locations || [], special),
    targeting_automation: { advantage_audience: input.advantageAudience ? 1 : 0 },
  };
  // Special ad categories don't allow age or gender targeting.
  if (!special) {
    targeting.age_min = Number(input.ageMin) || 18;
    targeting.age_max = Number(input.ageMax) || 65;
    if (input.gender === 'male') targeting.genders = [1];
    if (input.gender === 'female') targeting.genders = [2];
  }
  if (input.placements === 'manual') Object.assign(targeting, MANUAL_PLACEMENTS);

  const params = {
    name: input.name.trim(),
    campaign_id: campaign.id,
    status: input.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
    billing_event: 'IMPRESSIONS',
    optimization_goal: goal.optimization_goal,
    targeting,
  };
  if (goal.destination_type) params.destination_type = goal.destination_type;
  if (goal.pixel) params.promoted_object = { pixel_id: input.pixelId, custom_event_type: input.event || goal.event };
  if (!isCbo(campaign)) {
    params.daily_budget = toMinorUnits(input.dailyBudget, currency);
    params.bid_strategy = 'LOWEST_COST_WITHOUT_CAP';
  }
  if (input.startTime) params.start_time = new Date(input.startTime).toISOString();
  return params;
}

async function createAdset(client, accountId, input, campaign, currency) {
  const res = await client.post(`${accountId}/adsets`, buildAdsetParams(input, campaign, currency));
  return res.id;
}

async function copyAdset(client, sourceId, { name, dailyBudget, status }, campaign, currency) {
  const res = await client.post(`${sourceId}/copies`, {
    campaign_id: campaign.id, // lets you copy an ad set into a different (e.g. empty) campaign
    deep_copy: false, // settings only, not the source's ads
    status_option: status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED',
  });
  const id = res.copied_adset_id || (res.ad_object_ids && res.ad_object_ids[0] && res.ad_object_ids[0].copied_id);
  if (!id) throw new Error('Meta did not return the copied ad set id');
  const update = {};
  if (name && name.trim()) update.name = name.trim();
  if (Number(dailyBudget) > 0 && !isCbo(campaign)) update.daily_budget = toMinorUnits(dailyBudget, currency);
  if (Object.keys(update).length) await client.post(id, update);
  return id;
}

module.exports = { GOALS, CONVERSION_EVENTS, buildAdsetParams, validateNewAdset, createAdset, copyAdset, toMinorUnits, isCbo };
