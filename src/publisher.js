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
  if (!d.link) errs.push('website (destination link) is required');
  else if (!/^https?:\/\//i.test(d.link)) errs.push('website (destination link) must start with http(s)://');
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
  if (media.kind === 'video' && draft.displayLink && cta.value) cta.value.link_caption = draft.displayLink;

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
      caption: draft.displayLink || undefined,
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

// Sent as a multipart file (not base64 text, which is a third bigger and can hit HTTP 413).
async function uploadImage(client, accountId, file) {
  const form = new FormData();
  form.append('filename', new Blob([file.buffer], { type: file.mimetype }), file.originalname);
  const res = await client.postForm(`${actId(accountId)}/adimages`, form);
  const img = Object.values(res.images || {})[0];
  if (!img || !img.hash) throw new Error('Image upload returned no hash');
  return { kind: 'image', imageHash: img.hash };
}

// Resumable upload in chunks to Meta's video host, so any size works.
async function uploadVideoFile(client, accountId, file, log = () => {}) {
  const path = `${actId(accountId)}/advideos`;
  const size = file.buffer.length;
  const start = await client.post(path, { upload_phase: 'start', file_size: String(size) }, { video: true });
  const session = start.upload_session_id;
  let from = Number(start.start_offset);
  let to = Number(start.end_offset);
  while (from < to) {
    const form = new FormData();
    form.append('upload_phase', 'transfer');
    form.append('upload_session_id', session);
    form.append('start_offset', String(from));
    form.append('video_file_chunk', new Blob([file.buffer.subarray(from, to)]), file.originalname);
    let next;
    try {
      next = await client.postForm(path, form, { video: true });
    } catch (err) {
      log(`Chunk upload failed (${err.message}), retrying once…`);
      next = await client.postForm(path, form, { video: true });
    }
    from = Number(next.start_offset);
    to = Number(next.end_offset);
    if (size > 0) log(`Uploading video… ${Math.min(100, Math.round((from / size) * 100))}%`);
  }
  await client.post(path, { upload_phase: 'finish', upload_session_id: session, title: file.originalname }, { video: true });
  return start.video_id;
}

async function uploadVideo(client, accountId, file, { pollMs = 5000, timeoutMs = 10 * 60 * 1000, log = () => {}, wait = true } = {}) {
  const videoId = await uploadVideoFile(client, accountId, file, log);
  if (!wait) return { kind: 'video', videoId }; // Ads Manager picks it up once processed
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
 * drafts:  [{ name, primaryText, headline, description, cta, link, displayLink, urlTags, media: multerFile }]
 * targets: [{ accountId, accountName, campaignName, adsetId, adsetName, pageId, instagramUserId }]
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
      const result = {
        draft: i,
        accountId: target.accountId,
        accountName: target.accountName,
        campaignName: target.campaignName,
        adsetId: target.adsetId,
        adsetName: target.adsetName,
      };
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

// Uploads each draft's media to each account's media library (no Page needed),
// for building an Ads Manager import file.
async function uploadMediaLibrary(client, { drafts, accountIds }, emit) {
  for (const accountId of accountIds) {
    for (let i = 0; i < drafts.length; i++) {
      const file = drafts[i].media;
      const isVideo = file.mimetype.startsWith('video/');
      try {
        emit({ type: 'log', message: `[${actId(accountId)}] Uploading ${file.originalname}…` });
        const media = isVideo
          ? await uploadVideo(client, accountId, file, { wait: false })
          : await uploadImage(client, accountId, file);
        emit({ type: 'media', accountId, draft: i, ok: true, ...media });
      } catch (err) {
        emit({ type: 'media', accountId, draft: i, ok: false, error: err.message });
        emit({ type: 'log', message: `[${actId(accountId)}] FAILED ${file.originalname}: ${err.message}` });
      }
    }
  }
  emit({ type: 'done' });
}

module.exports = {
  uploadMediaLibrary,
  CTA_TYPES,
  validateDraft,
  buildCreativeParams,
  createCreativeWithOptOuts,
  verifyOptOuts,
  publish,
};
