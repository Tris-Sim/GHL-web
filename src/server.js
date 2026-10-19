require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { createClient, API_VERSION } = require('./meta');
const { CTA_TYPES, validateDraft, publish } = require('./publisher');
const { CREATIVE_FEATURES } = require('./enhancements');

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
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => res.status(err.status || 500).json({ error: err.message }));

app.get('/api/config', (req, res) => {
  res.json({
    apiVersion: API_VERSION,
    tokenConfigured: Boolean(process.env.META_ACCESS_TOKEN),
    ctaTypes: CTA_TYPES,
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

app.get('/api/pages', wrap(async (req, res) => {
  const pages = await client().getAll('me/accounts', { fields: 'id,name,instagram_business_account{id,username}' });
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
  app.listen(PORT, HOST, () => console.log(`Ad publisher running at http://${HOST}:${PORT} (Graph API ${API_VERSION})`));
}

module.exports = app;
