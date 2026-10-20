const test = require('node:test');
const assert = require('node:assert');
const { buildCreativeParams, createCreativeWithOptOuts, publish, validateDraft } = require('../src/publisher');
const { CREATIVE_FEATURES } = require('../src/enhancements');
const { GraphError } = require('../src/meta');

const draft = {
  name: 'Test ad', primaryText: 'Body copy', headline: 'Big headline', description: 'Small text',
  cta: 'GET_QUOTE', link: 'https://example.com', urlTags: '?utm_source=fb',
  media: { mimetype: 'image/png', buffer: Buffer.from('img'), originalname: 'a.png' },
};
const target = { accountId: '123', adsetId: '999', adsetName: 'Set A', pageId: 'p1', instagramUserId: 'ig1' };

test('image creative carries copy, CTA and every enhancement opted out', () => {
  const p = buildCreativeParams(draft, target, { kind: 'image', imageHash: 'h' });
  const ld = p.object_story_spec.link_data;
  assert.equal(ld.message, 'Body copy');
  assert.equal(ld.name, 'Big headline');
  assert.equal(ld.description, 'Small text');
  assert.deepEqual(ld.call_to_action, { type: 'GET_QUOTE', value: { link: 'https://example.com' } });
  assert.equal(p.object_story_spec.instagram_user_id, 'ig1');
  assert.equal(p.url_tags, 'utm_source=fb');
  assert.deepEqual(p.contextual_multi_ads, { enroll_status: 'OPT_OUT' });
  const spec = p.degrees_of_freedom_spec.creative_features_spec;
  assert.equal(Object.keys(spec).length, CREATIVE_FEATURES.length);
  for (const v of Object.values(spec)) assert.equal(v.enroll_status, 'OPT_OUT');
});

test('video creative maps headline/description to video fields', () => {
  const p = buildCreativeParams(draft, target, { kind: 'video', videoId: 'v1', thumbnailUrl: 'https://t' });
  const vd = p.object_story_spec.video_data;
  assert.equal(vd.title, 'Big headline');
  assert.equal(vd.link_description, 'Small text');
  assert.equal(vd.video_id, 'v1');
  assert.equal(p.object_story_spec.link_data, undefined);
});

test('rejected enhancement keys are dropped and retried', async () => {
  const sent = [];
  const client = {
    async post(path, params) {
      sent.push(params);
      const keys = Object.keys(params.degrees_of_freedom_spec.creative_features_spec);
      if (keys.includes('video_to_big')) throw new GraphError({ message: 'Invalid parameter: video_to_big is not a valid feature' }, 400);
      if (params.contextual_multi_ads) throw new GraphError({ message: 'contextual_multi_ads not supported' }, 400);
      return { id: 'cr1' };
    },
  };
  const r = await createCreativeWithOptOuts(client, '123', draft, target, { kind: 'image', imageHash: 'h' });
  assert.equal(r.creativeId, 'cr1');
  assert.deepEqual(r.dropped, ['video_to_big', 'contextual_multi_ads']);
  assert.equal(sent.length, 3);
});

test('unrelated errors are not retried', async () => {
  const client = { async post() { throw new GraphError({ message: 'Invalid page_id' }, 400); } };
  await assert.rejects(createCreativeWithOptOuts(client, '1', draft, target, { kind: 'image', imageHash: 'h' }), /Invalid page_id/);
});

test('publish uploads media once per account and creates one ad per ad set', async () => {
  const calls = [];
  const client = {
    async postForm(path, form) {
      calls.push(path);
      assert.ok(form.get('filename') instanceof Blob); // sent as a file, not base64
      return { images: { 'a.png': { hash: 'h1' } } };
    },
    async post(path, params) {
      calls.push(path);
      if (path.endsWith('/adcreatives')) return { id: `cr${calls.length}` };
      if (path.endsWith('/ads')) { assert.equal(params.status, 'PAUSED'); return { id: `ad${calls.length}` }; }
      throw new Error(`unexpected ${path}`);
    },
    async get() { return { degrees_of_freedom_spec: { creative_features_spec: { image_touchups: { enroll_status: 'OPT_IN' } } } }; },
  };
  const events = [];
  const results = await publish(client, {
    drafts: [draft],
    targets: [target, { ...target, adsetId: '1000', adsetName: 'Set B' }, { ...target, accountId: '456', adsetId: '2000' }],
  }, (e) => events.push(e));
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal(calls.filter((c) => c.endsWith('/adimages')).length, 2); // accounts 123 and 456
  assert.equal(calls.filter((c) => c.endsWith('/ads')).length, 3);
  assert.deepEqual(results[0].stillEnabled, ['image_touchups=OPT_IN']);
  assert.equal(events.at(-1).type, 'done');
});

test('validation catches missing fields', () => {
  const errs = validateDraft({ cta: 'NOPE', link: 'example.com' }, 0);
  assert.ok(errs.some((e) => /primary text/.test(e)));
  assert.ok(errs.some((e) => /headline/.test(e)));
  assert.ok(errs.some((e) => /http/.test(e)));
  assert.ok(errs.some((e) => /call to action/.test(e)));
  assert.ok(errs.some((e) => /image or video/.test(e)));
});

test('display link maps to caption (image) and link_caption (video)', () => {
  const d = { ...draft, displayLink: 'mysite.com' };
  assert.equal(buildCreativeParams(d, target, { kind: 'image', imageHash: 'h' }).object_story_spec.link_data.caption, 'mysite.com');
  const vd = buildCreativeParams(d, target, { kind: 'video', videoId: 'v', thumbnailUrl: 't' }).object_story_spec.video_data;
  assert.equal(vd.call_to_action.value.link_caption, 'mysite.com');
});

test('results carry account and campaign names for grouping', async () => {
  const client = {
    async postForm() { return { images: { 'a.png': { hash: 'h' } } }; },
    async post() { return { id: 'x' }; },
    async get() { return {}; },
  };
  const [r] = await publish(client, { drafts: [draft], targets: [{ ...target, accountName: 'Roofing Co', campaignName: 'Leads' }] }, () => {});
  assert.equal(r.accountName, 'Roofing Co');
  assert.equal(r.campaignName, 'Leads');
});

test('videos upload in chunks to the video host', async () => {
  const { uploadMediaLibrary } = require('../src/publisher');
  const buf = Buffer.alloc(25);
  const calls = [];
  const client = {
    async post(path, params, opts) {
      calls.push(['post', params.upload_phase, opts]);
      if (params.upload_phase === 'start') return { upload_session_id: 'sess', video_id: 'vid9', start_offset: '0', end_offset: '10' };
      return { success: true };
    },
    async postForm(path, form, opts) {
      const from = Number(form.get('start_offset'));
      calls.push(['chunk', from, form.get('video_file_chunk').size, opts]);
      const next = Math.min(from + 10, 25);
      return { start_offset: String(next), end_offset: String(next === 25 ? 25 : Math.min(next + 10, 25)) };
    },
  };
  const events = [];
  await uploadMediaLibrary(client, { drafts: [{ media: { mimetype: 'video/mp4', buffer: buf, originalname: 'v.mp4' } }], accountIds: ['1'] }, (e) => events.push(e));
  const media = events.find((e) => e.type === 'media');
  assert.equal(media.videoId, 'vid9');
  assert.deepEqual(calls.filter((c) => c[0] === 'chunk').map((c) => [c[1], c[2]]), [[0, 10], [10, 10], [20, 5]]);
  assert.ok(calls.every((c) => c.at(-1)?.video === true));
  assert.equal(calls.at(-1)[1], 'finish');
});

test('client sends video calls to graph-video and explains 413', async () => {
  const { createClient } = require('../src/meta');
  const urls = [];
  const fetchImpl = async (url) => { urls.push(String(url)); return { ok: urls.length < 3, status: urls.length < 3 ? 200 : 413, json: async () => ({}) }; };
  const c = createClient('t', { fetchImpl });
  await c.post('act_1/advideos', { upload_phase: 'start' }, { video: true });
  await c.post('act_1/adimages', {});
  assert.match(urls[0], /^https:\/\/graph-video\.facebook\.com\//);
  assert.match(urls[1], /^https:\/\/graph\.facebook\.com\//);
  await assert.rejects(c.post('act_1/adimages', {}), /too large \(HTTP 413\)/);
});
