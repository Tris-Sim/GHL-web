// Every Advantage+ creative enhancement we explicitly opt out of.
//
// Meta removed the single "standard_enhancements" switch in Marketing API
// v22, so each feature has to be opted out one by one. The list changes as
// Meta adds/retires features; anything Meta rejects as unknown is dropped
// automatically at publish time (see publisher.js) and reported back, and
// the creative is re-read afterwards so you can see what actually stuck.
const CREATIVE_FEATURES = [
  'adapt_to_placement',
  'add_text_overlay',
  'creative_stickers',
  'cv_transformation',
  'description_automation',
  'enhance_cta',
  'hide_price',
  'image_animation',
  'image_auto_crop',
  'image_background_gen',
  'image_brightness_and_contrast',
  'image_enhancement',
  'image_templates',
  'image_touchups',
  'image_uncrop',
  'inline_comment',
  'local_store_extension',
  'media_liquidity_animated_image',
  'media_order',
  'media_type_automation',
  'multi_photo_to_video',
  'music',
  'pac_relaxation',
  'product_extensions',
  'product_metadata_automation',
  'profile_card',
  'replace_media_text',
  'reveal_details_over_time',
  'show_destination_blurbs',
  'show_summary',
  'site_extensions',
  'text_optimizations',
  'text_translation',
  'translate_text',
  'video_auto_crop',
  'video_filtering',
  'video_highlight',
  'video_to_big',
];

function buildFeaturesSpec(features = CREATIVE_FEATURES) {
  const spec = {};
  for (const f of features) spec[f] = { enroll_status: 'OPT_OUT' };
  return spec;
}

module.exports = { CREATIVE_FEATURES, buildFeaturesSpec };
