# Bulk Ad Publisher

A small dashboard for pushing the same ads into many Meta ad accounts / ad sets
at once, with **every Advantage+ creative enhancement turned off**.

For each ad you set:

- Image or video
- Primary text
- Headline
- Description
- Call-to-action button
- Website (destination link). Websites you've used before are suggested as you type
- Display link (optional, the website text shown on the ad)
- URL parameters (optional, for UTM tracking)

Every ad is published into every ad set you tick, across as many ad accounts as you want.

## Setup

```bash
npm install
cp .env.example .env    # paste your META_ACCESS_TOKEN
npm start               # http://127.0.0.1:3000
```

### Creating `.env`

The file must be named exactly `.env` and sit next to `package.json`. It holds one line:

```
META_ACCESS_TOKEN=your-token
```

- **Mac:** `nano .env`, paste the line, then Ctrl+O, Enter, Ctrl+X. Don't use TextEdit, which saves rich text.
- **Windows:** `notepad .env` (click Yes to create it), paste the line, then save.

If the dashboard says the token is missing, the server prints why when it starts.

### Getting a token

1. Business Settings → Users → **System users** → add one (Admin).
2. Assign it your ad accounts (Manage campaigns) and Pages.
3. **Generate new token** for your Meta app with `ads_management`, `ads_read`,
   `pages_show_list`, `pages_read_engagement`, `business_management`.

## How it works

The dashboard walks through four steps, with Back / Continue in the bar at the bottom:

1. **Destinations**: tick the ad sets the ads go into. View them by ad account
   (account → campaign → ad set), by campaign, or as one sortable ad set table,
   and use the search box to narrow the list. Under **Post as**, pick the Facebook
   Page (and linked Instagram) each account publishes from.

   **New ad sets**: use **+ New ad set** (or **+ Ad set** on a campaign, or **Copy** on any
   ad set row). New ad sets are ticked automatically.
   - *Copy an existing ad set*: copies the settings only (audience, locations, placements,
     optimization, pixel). **No ads are copied.** You can copy into a different campaign,
     rename it and change the daily budget.
   - *Start from scratch*: name, daily budget (skipped for campaign-budget campaigns), pixel and
     conversion event (leads/sales campaigns), locations (city with radius, ZIP, state or country),
     age, gender and placements. Advantage+ audience is off by default. Housing/jobs/credit
     campaigns automatically drop age/gender and use at least a 15 mile radius.
     Available for leads, sales, traffic and awareness campaigns; for other objectives, copy one.
   - Ad sets are created paused unless you pick Active.

   Campaigns themselves are still created in Ads Manager.
2. **Ads**: each ad is a card you open and close. Add media, primary text, headline,
   description, button and website. Ad name, display link and URL parameters are under
   *More options*. Counters warn when copy will be cut off in feed. Text is saved in
   your browser between sessions; media files are not.
3. **Review**: a Facebook and Instagram preview of every ad, every field listed out,
   checks (copy length, tracking parameters, missing Instagram), where each ad goes,
   and the publish settings: **Paused** (default) or **Live**, and **Test run**, which
   checks everything without creating ads.
4. **Publish**: live progress, then results grouped by ad account, campaign, ad set or ad.

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
