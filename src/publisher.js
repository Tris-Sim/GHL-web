// Turns ad drafts + target ad sets into creatives and ads on Meta.
const { CREATIVE_FEATURES, buildFeaturesSpec } = require('./enhancements');

const CTA_TYPES = [
  'LEARN_MORE', 'SIGN_UP', 'GET_QUOTE', 'BOOK_NOW', 'CONTACT_US', 'APPLY_NOW',
  'GET_OFFER', 'SHOP_NOW', 'ORDER_NOW', 'SUBSCRIBE', 'DOWNLOAD', 'WATCH_MORE',
  'SEND_MESSAGE', 'CALL_NOW', 'NO_BUTTON',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const actId = (id) => (String(id).startsWith('act_') ? String(id) : `act_${id}`);

function validateDraft(d, i) {
  const label = `Ad #${i + 1}${d.name ? ` (${d.name})` : ''}`;
  const errs = [];
  if (!d.primaryText) errs.push('primary text is required');
  if (!d.headline) errs.push('headline is required');
  if (!d.link) errs.push('destination URL is required');
  else if (!/^https?:\/\//i.test(d.link)) errs.push('destination URL must start with http(s)://');
  if (!CTA_TYPES.includes(d.cta)) errs.push(`unknown call to action "${d.cta}"`);
  if (!d.media) errs.push('an image or video is required');
  return errs.map((e) => `${label}: ${e}`);
}

function buildObjectStorySpec(draft, target, media) {
  const spec = { page_id: target.pageId };
  if (target.instagramUserId) spec.instagram_user_id = target.instagramUserId;
  const cta = draft.cta === 'NO_BUTTON'
    ? { type: 'NO_BUTTON' }
    : { type: draft.cta, value: { link: draft.link } };

  if (media.kind === 'video') {
    spec.video_data = {
      video_id: media.videoId,
      image_url: media.thumbnailUrl,
      message: draft.primaryText,
      title: draft.headline,
      link_description: draft.description || undefined,
      call_to_action: cta,
    };
  } else {
    spec.link_data = {
      link: draft.link,
      message: draft.primaryText,
      name: draft.headline,
      description: draft.description || undefined,
      image_hash: media.imageHash,
      call_to_action: cta,
    };
  }
  return spec;
}

function buildCreativeParams(draft, target, media, features = CREATIVE_FEATURES, extras = { contextual_multi_ads: true }) {
  const params = {
    name: `${draft.name || draft.headline} — creative`,
    object_story_spec: buildObjectStorySpec(draft, target, media),
    degrees_of_freedom_spec: { creative_features_spec: buildFeaturesSpec(features) },
  };
  if (extras.contextual_multi_ads) params.contextual_multi_ads = { enroll_status: 'OPT_OUT' };
  if (draft.urlTags) params.url_tags = draft.urlTags.replace(/^\?/, '');
  return params;
}

// Meta rejects feature keys it doesn't (or no longer) support. When the
// error names one of our keys, drop it and retry so one stale key never
// blocks a launch. Everything dropped is reported back to the dashboard.
function featuresNamedInError(err, features) {
  const text = [err.message, err.graph && JSON.stringify(err.graph)].join(' ');
  return features.filter((f) => new RegExp(`\\b${f}\\b`).test(text));
}

async function createCreativeWithOptOuts(client, accountId, draft, target, media, log = () => {}) {
  let features = [...CREATIVE_FEATURES];
  const extras = { contextual_multi_ads: true };
  const dropped = [];
  for (let attempt = 0; attempt < CREATIVE_FEATURES.length + 2; attempt++) {
    try {
      const res = await client.post(`${actId(accountId)}/adcreatives`, buildCreativeParams(draft, target, media, features, extras));
      return { creativeId: res.id, dropped };
    } catch (err) {
      const bad = featuresNamedInError(err, features);
      if (bad.length) {
        features = features.filter((f) => !bad.includes(f));
        dropped.push(...bad);
        log(`Meta rejected enhancement key(s) ${bad.join(', ')} — retrying without them`);
        continue;
      }
      if (extras.contextual_multi_ads && /contextual_multi_ads/.test(err.message + JSON.stringify(err.graph || {}))) {
        extras.contextual_multi_ads = false;
        dropped.push('contextual_multi_ads');
        log('Meta rejected contextual_multi_ads opt-out — retrying without it');
        continue;
      }
      throw err;
    }
  }
  throw new Error('Gave up creating creative after repeated enhancement-key rejections');
}

// Reads the creative back and lists any enhancement that is NOT opted out.
async function verifyOptOuts(client, creativeId) {
  const c = await client.get(creativeId, { fields: 'degrees_of_freedom_spec' });
  const spec = (c.degrees_of_freedom_spec && c.degrees_of_freedom_spec.creative_features_spec) || {};
  return Object.entries(spec)
    .filter(([, v]) => v && v.enroll_status && v.enroll_status !== 'OPT_OUT')
    .map(([k, v]) => `${k}=${v.enroll_status}`);
}

async function uploadImage(client, accountId, file) {
  const res = await client.post(`${actId(accountId)}/adimages`, { bytes: file.buffer.toString('base64') });
  const img = Object.values(res.images || {})[0];
  if (!img || !img.hash) throw new Error('Image upload returned no hash');
  return { kind: 'image', imageHash: img.hash };
}

async function uploadVideo(client, accountId, file, { pollMs = 5000, timeoutMs = 10 * 60 * 1000, log = () => {} } = {}) {
  const form = new FormData();
  form.append('name', file.originalname);
  form.append('source', new Blob([file.buffer], { type: file.mimetype }), file.originalname);
  const { id: videoId } = await client.postForm(`${actId(accountId)}/advideos`, form);
  const started = Date.now();
  for (;;) {
    const v = await client.get(videoId, { fields: 'status' });
    const status = v.status && v.status.video_status;
    if (status === 'ready') break;
    if (status === 'error') throw new Error(`Meta failed to process video ${file.originalname}`);
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for video ${file.originalname} to process`);
    log(`Video processing (${status || 'pending'})…`);
    await sleep(pollMs);
  }
  const thumbs = await client.get(`${videoId}/thumbnails`, { fields: 'uri,is_preferred' });
  const list = thumbs.data || [];
  const thumb = list.find((t) => t.is_preferred) || list[0];
  if (!thumb) throw new Error('Video has no thumbnail yet');
  return { kind: 'video', videoId, thumbnailUrl: thumb.uri };
}

/**
 * Publishes every draft into every target ad set.
 * drafts:  [{ name, primaryText, headline, description, cta, link, urlTags, media: multerFile }]
 * targets: [{ accountId, adsetId, adsetName, pageId, instagramUserId }]
 * emit(event) receives progress events: { type: 'log'|'result'|'done', ... }
 */
async function publish(client, { drafts, targets, status = 'PAUSED', dryRun = false }, emit, opts = {}) {
  const mediaCache = new Map(); // `${account}|${draftIndex}` → uploaded media
  const results = [];
  for (const target of targets) {
    for (let i = 0; i < drafts.length; i++) {
      const draft = drafts[i];
      const where = `${target.adsetName || target.adsetId} (${actId(target.accountId)})`;
      const log = (message) => emit({ type: 'log', message: `[${draft.name || draft.headline} → ${where}] ${message}` });
      const result = { draft: i, accountId: target.accountId, adsetId: target.adsetId, adsetName: target.adsetName };
      try {
        const isVideo = draft.media.mimetype.startsWith('video/');
        if (dryRun) {
          const fakeMedia = isVideo
            ? { kind: 'video', videoId: '<uploaded video id>', thumbnailUrl: '<video thumbnail>' }
            : { kind: 'image', imageHash: '<uploaded image hash>' };
          result.preview = {
            creative: buildCreativeParams(draft, target, fakeMedia),
            ad: { name: draft.name || draft.headline, adset_id: target.adsetId, status },
          };
          result.ok = true;
        } else {
          const key = `${target.accountId}|${i}`;
          if (!mediaCache.has(key)) {
            log(`Uploading ${isVideo ? 'video' : 'image'}…`);
            const media = isVideo
              ? await uploadVideo(client, target.accountId, draft.media, { log, ...opts.video })
              : await uploadImage(client, target.accountId, draft.media);
            mediaCache.set(key, media);
          }
          log('Creating creative with all enhancements opted out…');
          const { creativeId, dropped } = await createCreativeWithOptOuts(client, target.accountId, draft, target, mediaCache.get(key), log);
          const ad = await client.post(`${actId(target.accountId)}/ads`, {
            name: draft.name || draft.headline,
            adset_id: target.adsetId,
            creative: { creative_id: creativeId },
            status,
          });
          Object.assign(result, { ok: true, adId: ad.id, creativeId, droppedFeatures: dropped });
          try {
            result.stillEnabled = await verifyOptOuts(client, creativeId);
          } catch (e) {
            result.verifyError = e.message;
          }
          log(`Ad ${ad.id} created (${status})`);
        }
      } catch (err) {
        result.ok = false;
        result.error = err.message;
        log(`FAILED: ${err.message}`);
      }
      results.push(result);
      emit({ type: 'result', result });
    }
  }
  emit({ type: 'done', ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  return results;
}

module.exports = {
  CTA_TYPES,
  validateDraft,
  buildCreativeParams,
  createCreativeWithOptOuts,
  verifyOptOuts,
  publish,
};
