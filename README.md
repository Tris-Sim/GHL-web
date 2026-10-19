# Bulk Ad Publisher

A small dashboard for pushing the same ads into many Meta ad accounts / ad sets
at once, with **every Advantage+ creative enhancement turned off**.

For each ad you set:

- Image or video
- Primary text
- Headline
- Description
- Call-to-action button
- Destination URL (+ optional URL parameters for UTM tracking)

Every ad is published into every ad set you tick, across as many ad accounts as you want.

## Setup

```bash
npm install
cp .env.example .env    # paste your META_ACCESS_TOKEN
npm start               # http://127.0.0.1:3000
```

### Getting a token

1. Business Settings → Users → **System users** → add one (Admin).
2. Assign it your ad accounts (Manage campaigns) and Pages.
3. **Generate new token** for your Meta app with `ads_management`, `ads_read`,
   `pages_show_list`, `pages_read_engagement`, `business_management`.

## How it works

1. **Where to publish**: lists every active ad account the token can see. Expand an
   account to tick ad sets, and pick the Facebook Page (and linked Instagram)
   for that account. Campaigns and ad sets (budget, audience, placements) are set up
   in Ads Manager. This tool only creates the ads.
2. **Ads**: add as many ad variations as you want. Text you type is saved
   in your browser between sessions. Media files are not saved.
3. **Publish**: ads are created **paused** by default. Tick *Dry run* to see the
   exact payload without creating anything.

For each target account it uploads the media once, creates the creative, then creates the ad.

## Enhancements off

Meta removed the single "standard enhancements" switch in Marketing API v22, so
each feature is opted out one by one in `degrees_of_freedom_spec.creative_features_spec`
(full list in `src/enhancements.js`), plus `contextual_multi_ads` (multi-advertiser ads).

- If Meta rejects a key as unknown or retired, it is dropped, the creative is retried,
  and the skipped key is listed in the results.
- After every ad is created, the creative is read back from Meta. Any enhancement
  that is still on is flagged in the results so you can check that ad.
- When Meta ships a new enhancement, add its key to `src/enhancements.js`.

Placement-level Advantage+ settings (Advantage+ placements, audience) live on the
ad set, so set those in Ads Manager.

## Development

```bash
npm test     # unit tests for payloads, retry logic and publish flow
npm run dev  # restart on file changes
```
