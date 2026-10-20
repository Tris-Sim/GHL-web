const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const state = {
  config: null, pages: [], accounts: [], selected: new Map(), drafts: [],
  results: [], publishedDrafts: [], step: 1, publishing: false, published: false,
  status: 'PAUSED', openDraft: 0, previewMode: {},
};
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function api(path) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const CTA_LABELS = {
  LEARN_MORE: 'Learn more', SIGN_UP: 'Sign up', GET_QUOTE: 'Get quote', BOOK_NOW: 'Book now', CONTACT_US: 'Contact us',
  APPLY_NOW: 'Apply now', GET_OFFER: 'Get offer', SHOP_NOW: 'Shop now', ORDER_NOW: 'Order now', SUBSCRIBE: 'Subscribe',
  DOWNLOAD: 'Download', WATCH_MORE: 'Watch more', SEND_MESSAGE: 'Send message', CALL_NOW: 'Call now', NO_BUTTON: 'No button',
};
const ctaLabel = (c) => CTA_LABELS[c] || String(c || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (x) => x.toUpperCase());

// Meta truncates long copy in feed; these are the usual cut-off points.
const LIMITS = { primaryText: 125, headline: 40 };

// ---------- Targets ----------
const pageChoices = store.get('pageChoices', {});
const openGroups = new Set(); // expanded account / campaign ids
state.view = store.get('view', 'account');
state.sort = store.get('sort', { key: 'name', dir: 1 });

function pageFor(accountId) {
  return pageChoices[accountId] || (state.pages[0] && state.pages[0].id) || '';
}
const pageById = (id) => state.pages.find((p) => p.id === id);

const byText = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
const sortRows = (rows, key) => rows.sort((a, b) => state.sort.dir * byText(key(a), key(b)));

async function loadAdsets(acc) {
  if (acc.adsets !== undefined) return;
  acc.adsets = null;
  try { acc.adsets = await api(`/api/accounts/${acc.id}/adsets`); } catch (e) { acc.adsets = []; acc.error = e.message; }
}

// Campaign / ad set views span every account, so load them all (4 at a time).
async function loadAllAdsets() {
  const queue = state.accounts.filter((a) => a.adsets === undefined);
  if (!queue.length) return;
  $('#accounts').innerHTML = `<p class="empty">Loading ad sets from ${plural(state.accounts.length, 'account')}…</p>`;
  await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await loadAdsets(queue.shift()); }));
}

// Flat rows: one per ad set, with its account attached.
function adsetRows() {
  const q = $('#account-search').value.trim().toLowerCase();
  return state.accounts.flatMap((acc) => (acc.adsets || []).map((s) => ({ acc, s })))
    .filter(({ acc, s }) => !q || [acc.name, acc.account_id, s.name, s.campaign?.name].some((t) => String(t || '').toLowerCase().includes(q)));
}

function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
}

function setSelected({ acc, s }, on) {
  if (on) state.selected.set(s.id, { accountId: acc.id, accountName: acc.name, campaignName: s.campaign?.name || '', adsetId: s.id, adsetName: s.name });
  else state.selected.delete(s.id);
}

// A checkbox that selects/deselects a set of ad set rows (indeterminate when partial).
function bulkBox(rows) {
  const box = document.createElement('input');
  box.type = 'checkbox';
  const n = rows.filter(({ s }) => state.selected.has(s.id)).length;
  box.checked = rows.length > 0 && n === rows.length;
  box.indeterminate = n > 0 && n < rows.length;
  box.addEventListener('click', (e) => e.stopPropagation());
  box.addEventListener('change', () => { rows.forEach((r) => setSelected(r, box.checked)); renderTargets(); });
  return box;
}

const statusBadge = (s) => `<span class="status ${s === 'ACTIVE' ? 'active' : ''}">${esc(String(s || '').replace(/_/g, ' ').toLowerCase())}</span>`;

function adsetLine(row, { showCampaign = true, showAccount = false, nested = false } = {}) {
  const { acc, s } = row;
  const label = document.createElement('label');
  label.className = `adset-row${nested ? ' nested' : ''}`;
  const sub = [showCampaign && s.campaign?.name, showAccount && acc.name].filter(Boolean);
  label.innerHTML = `<input type="checkbox" ${state.selected.has(s.id) ? 'checked' : ''}>
    <span>${esc(s.name)}${statusBadge(s.effective_status)}${sub.length ? `<span class="camp">${sub.map(esc).join(' · ')}</span>` : ''}</span>`;
  $('input', label).addEventListener('change', (e) => { setSelected(row, e.target.checked); renderTargets(); });
  return label;
}

function groupBlock({ id, title, meta, rows, body }) {
  const el = document.createElement('div');
  const open = openGroups.has(id);
  const count = rows.filter(({ s }) => state.selected.has(s.id)).length;
  el.className = `account${open ? ' open' : ''}${count ? ' has-selection' : ''}`;
  const head = document.createElement('div');
  head.className = 'account-head';
  head.innerHTML = '<span class="caret">▶</span>';
  if (rows.length) head.appendChild(bulkBox(rows));
  head.insertAdjacentHTML('beforeend', `<span class="name">${esc(title)}<span class="muted">${meta}</span></span>${count ? `<span class="count-badge">${count} selected</span>` : ''}`);
  head.addEventListener('click', async () => { if (open) openGroups.delete(id); else openGroups.add(id); await body.onOpen?.(); renderTargets(); });
  el.appendChild(head);
  if (open) {
    const box = document.createElement('div');
    box.className = 'adsets';
    body.render(box);
    el.appendChild(box);
  }
  return el;
}

function renderByAccount(root, q) {
  for (const acc of sortRows([...state.accounts], (a) => a.name)) {
    const rows = adsetRows().filter((r) => r.acc === acc);
    const accMatches = !q || [acc.name, acc.account_id].some((t) => String(t).toLowerCase().includes(q));
    if (q && !accMatches && !rows.length) continue;
    const shown = accMatches && !q ? (acc.adsets || []).map((s) => ({ acc, s })) : rows;
    root.appendChild(groupBlock({
      id: acc.id,
      title: acc.name,
      meta: `${esc(acc.account_id)} · ${esc(acc.currency)}${acc.adsets ? ` · ${plural(acc.adsets.length, 'ad set')}` : ''}`,
      rows: shown,
      body: {
        onOpen: () => loadAdsets(acc),
        render(box) {
          if (acc.adsets === null) box.innerHTML = '<p class="empty">Loading ad sets…</p>';
          else if (acc.error) box.innerHTML = `<div class="alert">${esc(acc.error)}</div>`;
          else if (!shown.length) box.innerHTML = '<p class="empty">No ad sets in this account yet. Create the campaign and ad set in Ads Manager first.</p>';
          else {
            const camps = groupBy(shown, (r) => r.s.campaign?.id || 'none');
            for (const camp of sortRows([...camps.values()], (rs) => rs[0].s.campaign?.name)) {
              const h = document.createElement('label');
              h.className = 'camp-head';
              h.appendChild(bulkBox(camp));
              h.insertAdjacentHTML('beforeend', `<strong>${esc(camp[0].s.campaign?.name || 'No campaign')}</strong>`);
              box.appendChild(h);
              for (const r of sortRows(camp, (x) => x.s.name)) box.appendChild(adsetLine(r, { showCampaign: false, nested: true }));
            }
          }
        },
      },
    }));
  }
}

function renderByCampaign(root) {
  const camps = groupBy(adsetRows(), (r) => r.s.campaign?.id || `none-${r.acc.id}`);
  for (const rows of sortRows([...camps.values()], (rs) => rs[0].s.campaign?.name)) {
    const { acc, s } = rows[0];
    root.appendChild(groupBlock({
      id: `c-${s.campaign?.id || acc.id}`,
      title: s.campaign?.name || 'No campaign',
      meta: `${esc(acc.name)} · ${plural(rows.length, 'ad set')}`,
      rows,
      body: { render(box) { sortRows(rows, (r) => r.s.name).forEach((r) => box.appendChild(adsetLine(r, { showCampaign: false }))); } },
    }));
  }
}

function renderByAdset(root) {
  const rows = adsetRows();
  const cols = [['name', 'Ad set', (r) => r.s.name], ['campaign', 'Campaign', (r) => r.s.campaign?.name], ['account', 'Ad account', (r) => r.acc.name], ['status', 'Status', (r) => r.s.effective_status]];
  const col = cols.find((c) => c[0] === state.sort.key) || cols[0];
  sortRows(rows, col[2]);
  const table = document.createElement('table');
  table.className = 'adset-table';
  const head = document.createElement('tr');
  const th0 = document.createElement('th');
  th0.style.width = '36px';
  th0.appendChild(bulkBox(rows));
  head.appendChild(th0);
  for (const [key, label] of cols) {
    const th = document.createElement('th');
    th.className = 'sortable';
    th.textContent = label + (state.sort.key === key ? (state.sort.dir > 0 ? ' ↑' : ' ↓') : '');
    th.addEventListener('click', () => { state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 }; store.set('sort', state.sort); renderTargets(); });
    head.appendChild(th);
  }
  table.createTHead().appendChild(head);
  const tbody = table.createTBody();
  for (const r of rows) {
    const tr = tbody.insertRow();
    const on = state.selected.has(r.s.id);
    tr.className = on ? 'sel' : '';
    tr.innerHTML = `<td><input type="checkbox" ${on ? 'checked' : ''}></td><td><strong>${esc(r.s.name)}</strong></td><td>${esc(r.s.campaign?.name)}</td><td class="muted">${esc(r.acc.name)}</td><td>${statusBadge(r.s.effective_status)}</td>`;
    const box = $('input', tr);
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', () => { setSelected(r, box.checked); renderTargets(); });
    tr.addEventListener('click', () => { setSelected(r, !state.selected.has(r.s.id)); renderTargets(); });
  }
  root.appendChild(table);
  if (!rows.length) root.insertAdjacentHTML('beforeend', '<p class="empty">No ad sets match.</p>');
}

function selectedAccounts() {
  const ids = [...new Set([...state.selected.values()].map((t) => t.accountId))];
  return ids.map((id) => state.accounts.find((a) => a.id === id)).filter(Boolean);
}

// One "post as" row per account that has ad sets selected.
function renderPages() {
  const accs = selectedAccounts();
  $('#pages-card').hidden = !accs.length;
  const list = $('#pages-list');
  list.innerHTML = '';
  for (const acc of accs) {
    const row = document.createElement('div');
    row.className = 'page-row';
    row.innerHTML = `<div><strong>${esc(acc.name)}</strong> <span class="muted">· ${plural([...state.selected.values()].filter((t) => t.accountId === acc.id).length, 'ad set')}</span></div>`;
    const select = document.createElement('select');
    select.innerHTML = (state.pages.length ? '' : '<option value="">No Pages available for this token</option>')
      + state.pages.map((p) => `<option value="${p.id}" ${p.id === pageFor(acc.id) ? 'selected' : ''}>${esc(p.name)}${p.instagram_business_account ? `  ·  IG @${esc(p.instagram_business_account.username)}` : '  ·  no Instagram'}</option>`).join('');
    select.addEventListener('change', () => { pageChoices[acc.id] = select.value; store.set('pageChoices', pageChoices); updateBar(); });
    row.appendChild(select);
    list.appendChild(row);
  }
}

async function renderTargets() {
  const q = $('#account-search').value.trim().toLowerCase();
  const root = $('#accounts');
  $$('#view-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  $('#sort-dir').textContent = state.sort.dir > 0 ? 'A → Z' : 'Z → A';
  renderPages();
  updateBar();
  if (!state.accounts.length) { if (!state.loadError) root.innerHTML = '<p class="empty">No active ad accounts found for this token.</p>'; return; }
  if (state.view !== 'account') await loadAllAdsets();
  root.innerHTML = '';
  if (state.view === 'campaign') renderByCampaign(root);
  else if (state.view === 'adset') renderByAdset(root);
  else renderByAccount(root, q);
  if (!root.children.length) root.innerHTML = '<p class="empty">Nothing matches your search.</p>';
}

// ---------- Drafts ----------
const DRAFT_FIELDS = ['name', 'primaryText', 'headline', 'description', 'cta', 'link', 'displayLink', 'urlTags'];
const saveDrafts = () => store.set('drafts', state.drafts.map(({ file, url, ...d }) => d));
const isUrl = (u) => /^https?:\/\/[^\s.]+\.[^\s]+/i.test(String(u || '').trim());

function missingFields(d) {
  const m = [];
  if (!d.file) m.push('image or video');
  if (!d.primaryText?.trim()) m.push('primary text');
  if (!d.headline?.trim()) m.push('headline');
  if (!isUrl(d.link)) m.push('website');
  return m;
}

function newDraft(from = {}) {
  const { file, url, ...rest } = from;
  const d = { cta: 'LEARN_MORE', ...rest };
  if (file) { d.file = file; d.url = url; }
  return d;
}

function setFile(d, file) {
  if (d.url && !state.drafts.some((x) => x !== d && x.url === d.url)) URL.revokeObjectURL(d.url);
  d.file = file;
  d.url = file ? URL.createObjectURL(file) : null;
}

function updateDraftHead(el, d, i) {
  $('.draft-title strong', el).textContent = d.name || d.headline || `Ad ${i + 1}`;
  const miss = missingFields(d);
  const meta = $('.draft-meta', el);
  meta.className = `draft-meta ${miss.length ? 'missing' : 'ready'}`;
  meta.textContent = miss.length ? `Needs ${miss.join(', ')}` : `Ready · ${ctaLabel(d.cta)} → ${hostOf(d.link)}`;
  const thumb = $('.thumb', el);
  if (d.file && d.file.type.startsWith('image/')) { thumb.style.backgroundImage = `url("${d.url}")`; thumb.textContent = ''; }
  else { thumb.style.backgroundImage = ''; thumb.textContent = d.file ? '▶' : '+'; }
  for (const k of Object.keys(LIMITS)) {
    const c = $(`[data-count="${k}"]`, el);
    const n = (d[k] || '').length;
    c.textContent = n > LIMITS[k] ? `${n} · cut off after ~${LIMITS[k]} in feed` : `${n}/${LIMITS[k]}`;
    c.classList.toggle('over', n > LIMITS[k]);
  }
}

function showMedia(el, d) {
  const drop = $('.drop', el);
  const box = $('.drop-preview', el);
  drop.classList.toggle('filled', Boolean(d.file));
  box.innerHTML = !d.file ? '' : d.file.type.startsWith('video/')
    ? `<video src="${d.url}" muted loop playsinline autoplay></video>`
    : `<img src="${d.url}" alt="">`;
}

function renderDrafts() {
  const root = $('#drafts');
  root.innerHTML = '';
  state.drafts.forEach((d, i) => {
    const el = $('#draft-tpl').content.firstElementChild.cloneNode(true);
    el.classList.toggle('open', state.openDraft === i);
    $('[data-f="cta"]', el).innerHTML = state.config.ctaTypes.map((c) => `<option value="${c}">${esc(ctaLabel(c))}</option>`).join('');
    for (const f of DRAFT_FIELDS) {
      const input = $(`[data-f="${f}"]`, el);
      input.value = d[f] || '';
      input.addEventListener('input', () => { d[f] = input.value; saveDrafts(); updateDraftHead(el, d, i); updateBar(); });
    }
    const file = $('[data-f="media"]', el);
    file.addEventListener('change', () => { if (file.files[0]) { setFile(d, file.files[0]); showMedia(el, d); updateDraftHead(el, d, i); updateBar(); } });
    showMedia(el, d);
    updateDraftHead(el, d, i);
    const head = $('.draft-head', el);
    const toggle = () => { state.openDraft = state.openDraft === i ? -1 : i; renderDrafts(); };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    $('.dup', el).addEventListener('click', (e) => {
      e.stopPropagation();
      state.drafts.splice(i + 1, 0, newDraft({ ...d, name: d.name ? `${d.name} copy` : '' }));
      state.openDraft = i + 1;
      saveDrafts(); renderDrafts();
    });
    $('.remove', el).addEventListener('click', (e) => {
      e.stopPropagation();
      if ((d.primaryText || d.headline || d.file) && !confirm('Remove this ad?')) return;
      state.drafts.splice(i, 1);
      if (!state.drafts.length) state.drafts.push(newDraft());
      state.openDraft = Math.min(state.openDraft, state.drafts.length - 1);
      saveDrafts(); renderDrafts();
    });
    root.appendChild(el);
  });
  updateBar();
}

// Websites you've published to before, offered as suggestions in the destination field.
function renderWebsites() {
  $('#websites').innerHTML = store.get('websites', []).map((u) => `<option value="${esc(u)}">`).join('');
}
function rememberWebsites() {
  const seen = store.get('websites', []);
  const used = state.drafts.map((d) => (d.link || '').trim()).filter(isUrl);
  store.set('websites', [...new Set([...used, ...seen])].slice(0, 30));
  renderWebsites();
}

// ---------- Review ----------
function hostOf(link) {
  try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return 'yoursite.com'; }
}

function truncate(text, n) {
  const t = String(text || '');
  if (t.length <= n) return { text: t, cut: false };
  return { text: t.slice(0, n).replace(/\s+\S*$/, ''), cut: true };
}

function mediaTag(d) {
  if (!d.file) return 'No media';
  return d.file.type.startsWith('video/')
    ? `<video src="${d.url}" muted loop playsinline autoplay></video>`
    : `<img src="${d.url}" alt="">`;
}

function avatar(page) {
  const pic = page?.picture?.data?.url;
  return `<div class="pv-avatar" ${pic ? `style="background-image:url('${esc(pic)}')"` : ''}>${pic ? '' : esc((page?.name || 'P')[0])}</div>`;
}

function previewFacebook(d, page) {
  const body = truncate(d.primaryText, LIMITS.primaryText);
  return `<div class="pv fb">
    <div class="pv-head">${avatar(page)}<div><div class="pv-name">${esc(page?.name || 'Your Page')}</div><div class="pv-sp">Sponsored · 🌐</div></div></div>
    <div class="pv-text">${esc(body.text)}${body.cut ? '… <span class="more-link">See more</span>' : ''}</div>
    <div class="pv-media">${mediaTag(d)}</div>
    <div class="pv-bar">
      <div class="pv-bar-text">
        <div class="pv-domain">${esc(d.displayLink || hostOf(d.link))}</div>
        <div class="pv-headline">${esc(d.headline || 'Your headline')}</div>
        ${d.description ? `<div class="pv-desc">${esc(d.description)}</div>` : ''}
      </div>
      ${d.cta !== 'NO_BUTTON' ? `<div class="pv-cta">${esc(ctaLabel(d.cta))}</div>` : ''}
    </div>
    <div class="pv-actions"><span>👍 Like</span><span>💬 Comment</span><span>↗ Share</span></div>
  </div>`;
}

function previewInstagram(d, page) {
  const ig = page?.instagram_business_account;
  const user = ig ? ig.username : (page?.name || 'yourpage').toLowerCase().replace(/\s+/g, '');
  const body = truncate(d.primaryText, LIMITS.primaryText);
  const hasCta = d.cta !== 'NO_BUTTON';
  return `<div class="pv ig ${hasCta ? 'has-cta' : ''}">
    <div class="pv-head">${avatar(page)}<div><div class="pv-name">${esc(user)}</div><div class="pv-sp">Sponsored</div></div></div>
    <div class="pv-media">${mediaTag(d)}</div>
    ${hasCta ? `<div class="pv-igbar"><span>${esc(ctaLabel(d.cta))}</span><span>›</span></div>` : ''}
    <div class="pv-icons">♡ 💬 ↗</div>
    <div class="pv-caption"><b>${esc(user)}</b>${esc(body.text)}${body.cut ? '… <span class="muted">more</span>' : ''}</div>
  </div>`;
}

function reviewChecks(d, pages) {
  const checks = [];
  const pt = (d.primaryText || '').length;
  const hl = (d.headline || '').length;
  checks.push(pt > LIMITS.primaryText
    ? ['warn', `Primary text is ${pt} characters, so people see the first ~${LIMITS.primaryText} before "See more". Make sure the hook is up front.`]
    : ['ok', 'Primary text fits without "See more".']);
  checks.push(hl > LIMITS.headline
    ? ['warn', `Headline is ${hl} characters and may be cut off on mobile (~${LIMITS.headline} fit).`]
    : ['ok', 'Headline fits on mobile.']);
  checks.push(d.urlTags
    ? ['ok', 'Tracking parameters added.']
    : ['warn', 'No URL parameters. Add UTMs under "More options" so you can track which ad drove each lead.']);
  if (pages.some((p) => !p?.instagram_business_account)) checks.push(['warn', 'At least one Page has no Instagram account connected, so Instagram placements will run from the Page instead.']);
  return checks;
}

function renderReview() {
  const ts = targets();
  const n = state.drafts.length;
  const accounts = new Set(ts.map((t) => t.accountId)).size;
  const campaigns = new Set(ts.map((t) => `${t.accountId}|${t.campaignName}`)).size;
  const word = (count, w) => plural(count, w).replace(/^\d+ /, '');
  $('#review-stats').innerHTML = [
    [n, word(n, 'ad')],
    [ts.length, word(ts.length, 'ad set')],
    [accounts, `${word(accounts, 'account')} · ${plural(campaigns, 'campaign')}`],
    [n * ts.length, 'ads to create', true],
  ].map(([v, k, hl]) => `<div class="stat ${hl ? 'hl' : ''}"><div class="v">${v}</div><div class="k">${esc(k)}</div></div>`).join('');

  const pages = [...new Set(ts.map((t) => t.pageId))].map(pageById);
  const root = $('#review-ads');
  root.innerHTML = '';
  state.drafts.forEach((d, i) => {
    const mode = state.previewMode[i] || 'fb';
    const card = document.createElement('div');
    card.className = 'card review-ad';
    card.innerHTML = `
      <div class="preview-col">
        <div class="seg pv-toggle"><button type="button" data-m="fb" class="${mode === 'fb' ? 'active' : ''}">Facebook</button><button type="button" data-m="ig" class="${mode === 'ig' ? 'active' : ''}">Instagram</button></div>
        ${mode === 'fb' ? previewFacebook(d, pages[0]) : previewInstagram(d, pages[0])}
        <div class="pv-note">Approximate preview. Meta's final layout varies by placement.</div>
      </div>
      <div>
        <h3>${esc(d.name || d.headline)}</h3>
        <dl class="kv">
          <dt>Primary text</dt><dd>${esc(d.primaryText)}</dd>
          <dt>Headline</dt><dd>${esc(d.headline)}</dd>
          <dt>Description</dt><dd>${esc(d.description || '—')}</dd>
          <dt>Button</dt><dd>${esc(ctaLabel(d.cta))}</dd>
          <dt>Website</dt><dd>${esc(d.link)}</dd>
          ${d.displayLink ? `<dt>Display link</dt><dd>${esc(d.displayLink)}</dd>` : ''}
          ${d.urlTags ? `<dt>URL parameters</dt><dd>${esc(d.urlTags)}</dd>` : ''}
          <dt>Media</dt><dd>${esc(d.file?.name || '—')}</dd>
          ${pages.length > 1 ? `<dt>Posting as</dt><dd>${pages.map((p) => esc(p?.name)).join(', ')}</dd>` : ''}
        </dl>
        <ul class="checks">${reviewChecks(d, pages).map(([k, t]) => `<li class="${k}"><span>${k === 'ok' ? '✓' : '!'}</span><span>${esc(t)}</span></li>`).join('')}</ul>
        <button type="button" class="edit-link">Edit this ad</button>
      </div>`;
    $$('.pv-toggle button', card).forEach((b) => b.addEventListener('click', () => { state.previewMode[i] = b.dataset.m; renderReview(); }));
    $('.edit-link', card).addEventListener('click', () => { state.openDraft = i; goTo(2); });
    root.appendChild(card);
  });

  const byAcc = groupBy(ts, (t) => t.accountId);
  $('#review-targets').innerHTML = [...byAcc.values()].map((rows) => {
    const page = pageById(rows[0].pageId);
    return `<div class="target-group"><strong>${esc(rows[0].accountName)}</strong>
      <span class="page">as ${esc(page?.name || 'no Page')}${page?.instagram_business_account ? ` · @${esc(page.instagram_business_account.username)}` : ''}</span>
      <ul>${rows.map((t) => `<li>${esc(t.adsetName)} <span class="muted">· ${esc(t.campaignName)}</span></li>`).join('')}</ul></div>`;
  }).join('');
  updateStatusNote();
}

function updateStatusNote() {
  $$('#status-seg button').forEach((b) => b.classList.toggle('active', b.dataset.status === state.status));
  $('#status-note').textContent = state.status === 'ACTIVE'
    ? 'Ads go live as soon as Meta approves them and start spending.'
    : "Ads are created paused. Turn them on in Ads Manager when you're ready.";
  updateBar();
}

// ---------- Steps ----------
function targets() {
  return [...state.selected.values()].map((t) => {
    const page = pageById(pageFor(t.accountId));
    return { ...t, pageId: page?.id, instagramUserId: page?.instagram_business_account?.id };
  });
}

// Returns why the given step isn't complete yet, or '' when it is.
function blocker(step) {
  if (step === 1) {
    if (!state.selected.size) return 'Select at least one ad set.';
    if (targets().some((t) => !t.pageId)) return 'Choose a Page for every account under "Post as".';
  }
  if (step === 2) {
    const bad = state.drafts.map((d, i) => [i, missingFields(d)]).filter(([, m]) => m.length);
    if (bad.length) return `Ad ${bad[0][0] + 1} needs ${bad[0][1].join(', ')}.`;
  }
  return '';
}

const reachable = (n) => (n === 4 ? state.published || state.publishing : [1, 2, 3].slice(0, n - 1).every((s) => !blocker(s)));

function goTo(n) {
  if (n > state.step && !reachable(n)) return;
  state.step = n;
  $$('.step').forEach((s) => { s.hidden = Number(s.dataset.step) !== n; });
  if (n === 2) renderDrafts();
  if (n === 3) renderReview();
  updateBar();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderStepper() {
  $$('.stepper li').forEach((li) => {
    const n = Number(li.dataset.step);
    li.classList.toggle('active', n === state.step);
    li.classList.toggle('done', n !== state.step && (n < state.step || state.published));
    $('button', li).disabled = state.publishing || (n !== state.step && !reachable(n));
  });
}

function updateBar() {
  const ts = targets();
  const n = state.drafts.length;
  const total = n * ts.length;
  const back = $('#back');
  const next = $('#next');
  const hint = blocker(state.step);
  back.hidden = state.step === 1 || state.publishing;
  back.textContent = state.step === 4 ? 'Back to review' : 'Back';
  next.hidden = state.step === 4;
  next.disabled = Boolean(hint) || state.publishing;
  $('#next-hint').textContent = state.step < 3 ? hint : '';
  if (state.step === 1) {
    $('#summary').textContent = ts.length ? `${plural(ts.length, 'ad set')} in ${plural(new Set(ts.map((t) => t.accountId)).size, 'account')}` : '';
    next.textContent = 'Continue to ads';
  } else if (state.step === 2) {
    $('#summary').textContent = `${plural(n, 'ad')} × ${plural(ts.length, 'ad set')}`;
    next.textContent = 'Review';
  } else if (state.step === 3) {
    $('#summary').textContent = `${plural(total, 'ad')} will be created ${state.status === 'ACTIVE' ? 'and go live' : 'paused'}`;
    next.textContent = $('#dry-run').checked ? 'Run test' : `Publish ${plural(total, 'ad')}`;
  } else {
    $('#summary').textContent = '';
  }
  renderStepper();
}

// ---------- Publish ----------
async function doPublish() {
  const dryRun = $('#dry-run').checked;
  const ts = targets();
  const total = state.drafts.length * ts.length;
  if (!dryRun && state.status === 'ACTIVE' && !confirm(`Create ${plural(total, 'ad')} and set them LIVE now? They will start spending once approved.`)) return;

  const form = new FormData();
  form.append('payload', JSON.stringify({ drafts: state.drafts.map(({ file, url, ...d }) => d), targets: ts, status: state.status, dryRun }));
  state.drafts.forEach((d, i) => { if (d.file) form.append(`media_${i}`, d.file); });

  Object.assign(state, { publishing: true, published: false, results: [], total, dryRun });
  state.publishedDrafts = state.drafts.map((d) => d.name || d.headline);
  rememberWebsites();
  $('#errors').hidden = true;
  $('#log').textContent = '';
  $('#new-batch').hidden = true;
  $('#results-title').textContent = dryRun ? 'Running test…' : 'Publishing…';
  goTo(4);
  renderResults();

  try {
    const res = await fetch('/api/publish', { method: 'POST', body: form });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handleEvent(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
      }
    }
  } catch (e) {
    $('#errors').textContent = e.message;
    $('#errors').hidden = false;
  } finally {
    state.publishing = false;
    state.published = true;
    const ok = state.results.filter((r) => r.ok).length;
    const failed = state.results.length - ok;
    $('#results-title').textContent = state.dryRun
      ? (failed || !ok ? 'Test finished with problems' : 'Test passed')
      : (failed || !ok ? `${plural(ok, 'ad')} created, ${failed} failed` : `${plural(ok, 'ad')} created`);
    $('#new-batch').hidden = false;
    renderResults();
    updateBar();
  }
}

function handleEvent(e) {
  if (e.type === 'log') $('#log').textContent += `${e.message}\n`;
  if (e.type === 'fatal') { $('#errors').textContent = e.error; $('#errors').hidden = false; }
  if (e.type === 'done') $('#log').textContent += `\nDone: ${e.ok} succeeded, ${e.failed} failed.\n`;
  if (e.type !== 'result') return;
  state.results.push(e.result);
  renderResults();
}

const RESULT_GROUPS = {
  account: (r) => r.accountName || r.accountId,
  campaign: (r) => r.campaignName || 'No campaign',
  adset: (r) => r.adsetName || r.adsetId,
  ad: (r) => r.adName,
};

function resultMessage(r) {
  if (!r.ok) return `<div class="msg bad">${esc(r.error)}</div>`;
  if (r.preview) return `<div class="msg">Checks passed. Nothing was created.<details><summary>What would be sent</summary><pre>${esc(JSON.stringify(r.preview, null, 2))}</pre></details></div>`;
  const notes = [];
  if (r.stillEnabled?.length) notes.push(`Meta still shows ON: ${r.stillEnabled.join(', ')}. Check this ad in Ads Manager.`);
  if (r.droppedFeatures?.length) notes.push(`Not accepted by Meta (skipped): ${r.droppedFeatures.join(', ')}`);
  if (r.verifyError) notes.push(`Could not verify enhancements: ${r.verifyError}`);
  return `<div class="msg">Ad ${esc(r.adId)} created${notes.map((n) => `<span class="warn">${esc(n)}</span>`).join('')}</div>`;
}

function renderResults() {
  const groupKey = $('#group-by').value;
  const rows = state.results.map((r) => ({ ...r, adName: state.publishedDrafts[r.draft] }));
  const groups = groupBy(rows, RESULT_GROUPS[groupKey]);
  const list = $('#results-list');
  list.innerHTML = '';
  for (const k of [...groups.keys()].sort(byText)) {
    const rs = groups.get(k);
    const ok = rs.filter((r) => r.ok).length;
    const g = document.createElement('div');
    g.className = 'result-group';
    g.innerHTML = `<div class="result-group-head"><span>${esc(k)}</span><span class="muted">${ok}/${rs.length} ok</span></div>`
      + rs.map((r) => {
        const where = [groupKey !== 'account' && (r.accountName || r.accountId), groupKey !== 'campaign' && r.campaignName, groupKey !== 'adset' && r.adsetName].filter(Boolean);
        const title = groupKey === 'ad' ? where.pop() : r.adName;
        return `<div class="result-row"><span class="ico ${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓' : '!'}</span>
          <strong>${esc(title)}</strong><span class="where">${where.map(esc).join(' · ')}</span>${resultMessage(r)}</div>`;
      }).join('');
    list.appendChild(g);
  }
  const ok = rows.filter((r) => r.ok).length;
  const pct = state.total ? Math.round((rows.length / state.total) * 100) : 0;
  $('#progress-bar').style.width = `${state.published ? 100 : pct}%`;
  $('#result-counts').textContent = `${ok} succeeded · ${rows.length - ok} failed${state.publishing ? ` · ${rows.length}/${state.total}` : ''}`;
  $('#results-sub').textContent = state.publishing
    ? 'Keep this tab open until it finishes.'
    : state.dryRun ? 'No ads were created. Turn off "Test run" in Review to publish for real.' : `Ads were created ${state.status === 'ACTIVE' ? 'live' : 'paused'}. Find them in Ads Manager.`;
}

// ---------- Boot ----------
async function init() {
  state.config = await api('/api/config');
  $('#enh-count').textContent = `(${state.config.optOutFeatures.length})`;
  $('#enh-list').innerHTML = state.config.optOutFeatures.map((f) => `<li>${esc(f.replace(/_/g, ' '))}</li>`).join('');
  $('#group-by').value = store.get('groupBy', 'account');
  state.drafts = store.get('drafts', []).map(newDraft);
  if (!state.drafts.length) state.drafts.push(newDraft());
  renderWebsites();
  goTo(1);

  const pill = $('#token-status');
  if (!state.config.tokenConfigured) {
    pill.textContent = 'Not connected';
    pill.className = 'pill bad';
    state.loadError = true;
    $('#accounts').innerHTML = `<div class="alert">${esc(state.config.tokenProblem || 'Add META_ACCESS_TOKEN to your .env file.')}\nFix it, then stop the server (Ctrl + C) and run npm start again.</div>`;
    return;
  }
  try {
    const [accounts, pages] = await Promise.all([api('/api/accounts'), api('/api/pages')]);
    state.accounts = accounts;
    state.pages = pages;
    pill.textContent = `Connected · ${plural(accounts.length, 'ad account')}`;
    pill.className = 'pill ok';
  } catch (e) {
    pill.textContent = 'Connection failed';
    pill.className = 'pill bad';
    state.loadError = true;
    $('#accounts').innerHTML = `<div class="alert">${esc(e.message)}</div>`;
    return;
  }
  renderTargets();
}

$('#add-draft').addEventListener('click', () => { state.drafts.push(newDraft()); state.openDraft = state.drafts.length - 1; saveDrafts(); renderDrafts(); });
$('#account-search').addEventListener('input', renderTargets);
$$('#view-tabs button').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  store.set('view', state.view);
  if (state.view !== 'adset') state.sort = { key: 'name', dir: state.sort.dir };
  renderTargets();
}));
$('#sort-dir').addEventListener('click', () => { state.sort.dir = -state.sort.dir; store.set('sort', state.sort); renderTargets(); });
$$('#status-seg button').forEach((b) => b.addEventListener('click', () => { state.status = b.dataset.status; updateStatusNote(); }));
$('#dry-run').addEventListener('change', updateBar);
$$('.stepper li').forEach((li) => $('button', li).addEventListener('click', () => goTo(Number(li.dataset.step))));
$('#back').addEventListener('click', () => goTo(state.step === 4 ? 3 : state.step - 1));
$('#next').addEventListener('click', () => (state.step === 3 ? doPublish() : goTo(state.step + 1)));
$('#group-by').addEventListener('change', () => { store.set('groupBy', $('#group-by').value); renderResults(); });
$('#new-batch').addEventListener('click', () => {
  state.selected.clear();
  Object.assign(state, { published: false, results: [] });
  goTo(1);
  renderTargets();
});
init().catch((e) => { $('#accounts').innerHTML = `<div class="alert">${esc(e.message)}</div>`; });
