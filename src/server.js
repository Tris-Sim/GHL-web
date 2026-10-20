const { loadEnv } = require('./env');

const envProblem = loadEnv();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { createClient, API_VERSION } = require('./meta');
const { CTA_TYPES, validateDraft, publish } = require('./publisher');
const { CREATIVE_FEATURES } = require('./enhancements');
const { GOALS, CONVERSION_EVENTS, validateNewAdset, createAdset, copyAdset } = require('./adsets');
const { INSIGHT_FIELDS, LEVELS, DATE_PRESETS, buildRows } = require('./insights');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.DASHBOARD_PASSWORD;

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 } });

// Optional HTTP basic auth — set DASHBOARD_PASSWORD if this is reachable by anyone but you.
if (PASSWORD) {
  app.use((req, res, next) => {
    const [, encoded] = (req.headers.authorization || '').split(' ');
    const pass = Buffer.from(encoded || '', 'base64').toString().split(':').slice(1).join(':');
    const a = Buffer.from(pass);
    const b = Buffer.from(PASSWORD);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Ad Publisher"').status(401).send('Authentication required');
  });
}

app.use(express.static(path.join(__dirname, '..', 'public')));

const client = () => createClient(process.env.META_ACCESS_TOKEN);
const actId = (id) => (String(id).startsWith('act_') ? String(id) : `act_${id}`);
const LIVE_STATUSES = ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'IN_PROCESS', 'WITH_ISSUES'];
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => res.status(err.status || 500).json({ error: err.message }));

app.get('/api/config', (req, res) => {
  res.json({
    apiVersion: API_VERSION,
    tokenConfigured: Boolean(process.env.META_ACCESS_TOKEN),
    tokenProblem: envProblem,
    ctaTypes: CTA_TYPES,
    adsetGoals: Object.fromEntries(Object.entries(GOALS).map(([k, g]) => [k, { pixel: Boolean(g.pixel), event: g.event || null }])),
    conversionEvents: CONVERSION_EVENTS,
    optOutFeatures: CREATIVE_FEATURES,
  });
});

app.get('/api/accounts', wrap(async (req, res) => {
  const accounts = await client().getAll('me/adaccounts', { fields: 'id,account_id,name,account_status,currency' });
  res.json(accounts.filter((a) => a.account_status === 1)); // 1 = ACTIVE
}));

app.get('/api/accounts/:id/adsets', wrap(async (req, res) => {
  const id = req.params.id.startsWith('act_') ? req.params.id : `act_${req.params.id}`;
  const adsets = await client().getAll(`${id}/adsets`, {
    fields: 'id,name,status,effective_status,campaign{id,name,objective}',
    filtering: [{ field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'IN_PROCESS', 'WITH_ISSUES'] }],
  });
  res.json(adsets);
}));

app.get('/api/accounts/:id/campaigns', wrap(async (req, res) => {
  const campaigns = await client().getAll(`${actId(req.params.id)}/campaigns`, {
    fields: 'id,name,objective,effective_status,daily_budget,lifetime_budget,special_ad_categories',
    filtering: [{ field: 'effective_status', operator: 'IN', value: LIVE_STATUSES }],
  });
  res.json(campaigns);
}));

app.get('/api/accounts/:id/pixels', wrap(async (req, res) => {
  res.json(await client().getAll(`${actId(req.params.id)}/adspixels`, { fields: 'id,name' }));
}));

// Location search for targeting (cities, ZIPs, regions, countries).
app.get('/api/geo', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const r = await client().get('search', {
    type: 'adgeolocation', q, limit: '10',
    location_types: ['city', 'zip', 'region', 'country'],
  });
  res.json((r.data || []).map((l) => ({
    key: l.key, type: l.type, name: l.name,
    label: [l.name, l.type === 'city' || l.type === 'zip' ? l.region : null, l.country_code].filter(Boolean).join(', '),
  })));
}));

// Create an ad set: { mode: 'copy', sourceAdsetId, name, dailyBudget, status }
// or { mode: 'new', campaignId, name, dailyBudget, status, pixelId, event, locations, ageMin, ageMax, gender, placements, advantageAudience }
app.post('/api/accounts/:id/adsets', express.json(), wrap(async (req, res) => {
  const c = client();
  const accountId = actId(req.params.id);
  const input = req.body || {};
  const { currency } = await c.get(accountId, { fields: 'currency' });
  const campaign = await c.get(input.campaignId, { fields: 'id,objective,daily_budget,lifetime_budget,special_ad_categories' });
  let id;
  if (input.mode === 'copy') {
    if (!input.sourceAdsetId) return res.status(400).json({ error: 'Pick the ad set to copy.' });
    id = await copyAdset(c, input.sourceAdsetId, input, campaign, currency);
  } else {
    const errs = validateNewAdset(input, campaign);
    if (errs.length) return res.status(400).json({ error: errs.join('\n') });
    id = await createAdset(c, accountId, input, campaign, currency);
  }
  const adset = await c.get(id, { fields: 'id,name,status,effective_status,campaign{id,name,objective}' });
  res.json(adset);
}));

// Performance table ("Tristen performance" columns) for one account.
// ?level=account|campaign|adset|ad&date_preset=last_7d  or  &since=YYYY-MM-DD&until=YYYY-MM-DD
const OBJECT_STATUSES = ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO'];
app.get('/api/accounts/:id/performance', wrap(async (req, res) => {
  const c = client();
  const id = actId(req.params.id);
  const level = LEVELS[req.query.level] ? req.query.level : 'adset';
  const range = req.query.since && req.query.until
    ? { time_range: { since: String(req.query.since), until: String(req.query.until) } }
    : { date_preset: DATE_PRESETS.includes(req.query.date_preset) ? req.query.date_preset : 'last_7d' };
  const live = (statuses) => [{ field: 'effective_status', operator: 'IN', value: statuses }];
  const [account, insights, totals, campaigns, adsets, ads] = await Promise.all([
    c.get(id, { fields: 'currency,name' }),
    c.getAll(`${id}/insights`, { level, fields: INSIGHT_FIELDS, ...range }, 5000),
    c.get(`${id}/insights`, { level: 'account', fields: INSIGHT_FIELDS, ...range }),
    level === 'account' ? [] : c.getAll(`${id}/campaigns`, { fields: 'id,name,effective_status,daily_budget,lifetime_budget', filtering: live(OBJECT_STATUSES) }),
    level === 'account' ? [] : c.getAll(`${id}/adsets`, { fields: 'id,name,campaign_id,effective_status,daily_budget,lifetime_budget,optimization_goal,promoted_object', filtering: live(OBJECT_STATUSES) }),
    level === 'ad' ? c.getAll(`${id}/ads`, { fields: 'id,name,adset_id,effective_status', filtering: live(OBJECT_STATUSES) }, 5000) : [],
  ]);
  const { rows, total } = buildRows(level, insights, { campaigns, adsets, ads }, (totals.data || [])[0] || {});
  res.json({ accountId: id, accountName: account.name, currency: account.currency, level, rows, total });
}));

// Pages this ad account is allowed to advertise for. Often finds Pages that
// /me/accounts doesn't list (e.g. client Pages shared to the business).
app.get('/api/accounts/:id/pages', wrap(async (req, res) => {
  const c = client();
  const path = `${actId(req.params.id)}/promote_pages`;
  try {
    res.json(await c.getAll(path, { fields: 'id,name,picture{url},instagram_business_account{id,username}' }));
  } catch {
    // Reading the linked Instagram account needs extra Page access; fall back to the basics.
    res.json(await c.getAll(path, { fields: 'id,name,picture{url}' }));
  }
}));

app.get('/api/pages', wrap(async (req, res) => {
  const pages = await client().getAll('me/accounts', { fields: 'id,name,picture{url},instagram_business_account{id,username}' });
  res.json(pages);
}));

// multipart: field "payload" (JSON) + files "media_<draftIndex>".
// Streams newline-delimited JSON progress events back to the dashboard.
app.post('/api/publish', upload.any(), async (req, res) => {
  let payload;
  try {
    payload = JSON.parse(req.body.payload || '{}');
  } catch {
    return res.status(400).json({ error: 'payload is not valid JSON' });
  }
  const files = Object.fromEntries((req.files || []).map((f) => [f.fieldname, f]));
  const drafts = (payload.drafts || []).map((d, i) => ({ ...d, media: files[`media_${i}`] }));
  const targets = payload.targets || [];
  const errors = drafts.flatMap(validateDraft);
  if (!drafts.length) errors.push('Add at least one ad');
  if (!targets.length) errors.push('Select at least one ad set');
  targets.forEach((t) => { if (!t.pageId) errors.push(`Pick a Facebook Page for ${t.adsetName || t.adsetId}`); });
  if (errors.length) return res.status(400).json({ error: errors.join('\n') });

  const status = payload.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';
  res.setHeader('Content-Type', 'application/x-ndjson');
  const emit = (e) => res.write(`${JSON.stringify(e)}\n`);
  try {
    const c = payload.dryRun ? null : client();
    await publish(c, { drafts, targets, status, dryRun: Boolean(payload.dryRun) }, emit);
  } catch (err) {
    emit({ type: 'fatal', error: err.message });
  }
  res.end();
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Ad publisher running at http://${HOST}:${PORT} (Graph API ${API_VERSION})`);
    console.log(process.env.META_ACCESS_TOKEN ? 'Meta token loaded.' : `WARNING: ${envProblem}`);
  });
}

module.exports = app;
