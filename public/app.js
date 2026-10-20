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
  label.appendChild(copyButton(row));
  return label;
}

// "Copy" opens the new ad set dialog with this ad set as the source (settings only, no ads).
function copyButton({ acc, s }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'row-copy';
  b.textContent = 'Copy';
  b.title = 'Copy this ad set without its ads';
  b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openAdsetDialog({ accountId: acc.id, campaignId: s.campaign?.id, source: s }); });
  return b;
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
              if (camp[0].s.campaign?.id) {
                const add = document.createElement('button');
                add.type = 'button';
                add.className = 'camp-add';
                add.textContent = '+ Ad set';
                add.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openAdsetDialog({ accountId: acc.id, campaignId: camp[0].s.campaign.id }); });
                h.appendChild(add);
              }
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
      body: {
        render(box) {
          sortRows(rows, (r) => r.s.name).forEach((r) => box.appendChild(adsetLine(r, { showCampaign: false })));
          if (s.campaign?.id) {
            const add = document.createElement('button');
            add.type = 'button';
            add.className = 'camp-add';
            add.textContent = '+ Add an ad set to this campaign';
            add.addEventListener('click', () => openAdsetDialog({ accountId: acc.id, campaignId: s.campaign.id }));
            box.appendChild(add);
          }
        },
      },
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
  head.appendChild(document.createElement('th'));
  table.createTHead().appendChild(head);
  const tbody = table.createTBody();
  for (const r of rows) {
    const tr = tbody.insertRow();
    const on = state.selected.has(r.s.id);
    tr.className = on ? 'sel' : '';
    tr.innerHTML = `<td><input type="checkbox" ${on ? 'checked' : ''}></td><td><strong>${esc(r.s.name)}</strong></td><td>${esc(r.s.campaign?.name)}</td><td class="muted">${esc(r.acc.name)}</td><td>${statusBadge(r.s.effective_status)}</td><td class="copy-cell"></td>`;
    $('.copy-cell', tr).appendChild(copyButton(r));
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

// ---------- New ad set ----------
const nas = { mode: 'copy', status: 'PAUSED', locations: [], geoTimer: null };
const loadCampaigns = async (acc) => { if (!acc.campaigns) acc.campaigns = await api(`/api/accounts/${acc.id}/campaigns`); return acc.campaigns; };
const loadPixels = async (acc) => { if (!acc.pixels) acc.pixels = await api(`/api/accounts/${acc.id}/pixels`); return acc.pixels; };
const currencySymbol = (cur) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: cur }).formatToParts(0).find((p) => p.type === 'currency').value; } catch { return cur; } };
const nasAccount = () => state.accounts.find((a) => a.id === $('#as-account').value);
const nasCampaign = () => (nasAccount()?.campaigns || []).find((c) => c.id === $('#as-campaign').value);
const isCboCampaign = (c) => Boolean(Number(c?.daily_budget) || Number(c?.lifetime_budget));
const isSpecial = (c) => (c?.special_ad_categories || []).some((x) => x && x !== 'NONE');
const prettyObjective = (o) => String(o || '').replace(/^OUTCOME_/, '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (x) => x.toUpperCase());

function nasError(msg) {
  $('#as-error').textContent = msg || '';
  $('#as-error').hidden = !msg;
}

async function openAdsetDialog({ accountId, campaignId, source } = {}) {
  nasError('');
  nas.locations = [];
  if (source) nas.mode = 'copy';
  $('#adset-dialog h3').textContent = source ? 'Copy ad set' : 'New ad set';
  $('#as-name').value = source ? `${source.name} copy` : '';
  $('#as-budget').value = '';
  $('#as-geo').value = '';
  renderChips();
  const accSel = $('#as-account');
  accSel.innerHTML = sortRows([...state.accounts], (a) => a.name).map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  const preferred = accountId || selectedAccounts()[0]?.id || state.accounts[0]?.id;
  if (preferred) accSel.value = preferred;
  $('#adset-dialog').showModal();
  await nasLoadAccount(campaignId, source?.id);
}

async function nasLoadAccount(campaignId, sourceId) {
  const acc = nasAccount();
  if (!acc) return;
  const campSel = $('#as-campaign');
  campSel.innerHTML = '<option>Loading…</option>';
  try {
    await Promise.all([loadCampaigns(acc), loadAdsets(acc)]);
  } catch (e) { nasError(e.message); return; }
  campSel.innerHTML = acc.campaigns.length
    ? sortRows([...acc.campaigns], (c) => c.name).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')
    : '<option value="">No campaigns. Create one in Ads Manager first</option>';
  // Default: the campaign you've already ticked ad sets in, else one that supports both modes.
  const picked = [...state.selected.values()].filter((t) => t.accountId === acc.id).map((t) => acc.adsets.find((s) => s.id === t.adsetId)?.campaign?.id);
  const fallback = acc.campaigns.find((c) => picked.includes(c.id)) || acc.campaigns.find((c) => state.config.adsetGoals[c.objective]);
  if (campaignId || fallback) campSel.value = campaignId || fallback.id;
  $('#as-cur').textContent = currencySymbol(acc.currency);
  nasCampaignChanged();
  if (sourceId) { $('#as-source').value = sourceId; nasRender(); }
}

function nasCampaignChanged() {
  const acc = nasAccount();
  const camp = nasCampaign();
  const adsets = acc?.adsets || [];
  const goal = camp && state.config.adsetGoals[camp.objective];
  const cbo = isCboCampaign(camp);
  $('#as-campaign-note').textContent = camp
    ? `${prettyObjective(camp.objective)} campaign · ${cbo ? 'campaign budget' : 'budget set per ad set'}${isSpecial(camp) ? ' · special ad category' : ''}`
    : '';

  // Copy list: this campaign's ad sets first, then the rest of the account.
  const same = adsets.filter((s) => s.campaign?.id === camp?.id);
  const other = adsets.filter((s) => s.campaign?.id !== camp?.id);
  const opts = (list) => sortRows([...list], (s) => s.name).map((s) => `<option value="${s.id}">${esc(s.name)}${s.campaign?.id === camp?.id ? '' : ` · ${esc(s.campaign?.name || '')}`}</option>`).join('');
  $('#as-source').innerHTML = (same.length ? `<optgroup label="In this campaign">${opts(same)}</optgroup>` : '')
    + (other.length ? `<optgroup label="Other campaigns in this account">${opts(other)}</optgroup>` : '');

  const copyBtn = $('#as-mode [data-mode="copy"]');
  const newBtn = $('#as-mode [data-mode="new"]');
  copyBtn.disabled = !adsets.length;
  newBtn.disabled = !goal;
  newBtn.title = goal ? '' : `Not available for ${prettyObjective(camp?.objective)} campaigns. Copy an existing ad set.`;
  if (nas.mode === 'copy' && copyBtn.disabled) nas.mode = 'new';
  if (nas.mode === 'new' && newBtn.disabled) nas.mode = 'copy';
  nasRender();
}

async function nasRender() {
  const camp = nasCampaign();
  const goal = camp && state.config.adsetGoals[camp.objective];
  const cbo = isCboCampaign(camp);
  const special = isSpecial(camp);
  $$('#as-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === nas.mode));
  $$('#as-status button').forEach((b) => b.classList.toggle('active', b.dataset.status === nas.status));
  $('#as-copy').hidden = nas.mode !== 'copy';
  $('#as-submit').textContent = nas.mode === 'copy' ? 'Copy ad set' : 'Create ad set';
  $('#as-new').hidden = nas.mode !== 'new';
  $('#as-budget-wrap').hidden = cbo;
  $('#as-budget-note').hidden = !cbo;
  $('#as-budget-note').textContent = 'This campaign uses a campaign budget, so the ad set has no budget of its own.';
  $('#as-budget-opt').textContent = nas.mode === 'copy' ? 'Leave empty to keep the source budget' : '';
  $('#as-budget').placeholder = nas.mode === 'copy' ? 'Same as source' : '20';
  $('#as-demo').hidden = special;
  $('#as-special').hidden = !special;
  $('#as-submit').disabled = !camp || (nas.mode === 'copy' && !$('#as-source').value);
  $('#as-conv').hidden = !(nas.mode === 'new' && goal?.pixel);
  if (nas.mode === 'new' && goal?.pixel) {
    $('#as-event').innerHTML = state.config.conversionEvents.map((e) => `<option value="${e}" ${e === goal.event ? 'selected' : ''}>${esc(prettyObjective(e))}</option>`).join('');
    const acc = nasAccount();
    const sel = $('#as-pixel');
    if (!acc.pixels) {
      sel.innerHTML = '<option>Loading…</option>';
      try { await loadPixels(acc); } catch (e) { acc.pixels = []; nasError(e.message); }
    }
    sel.innerHTML = acc.pixels.length
      ? acc.pixels.map((p) => `<option value="${p.id}">${esc(p.name)} · ${esc(p.id)}</option>`).join('')
      : '<option value="">No pixel on this account</option>';
  }
}

function renderChips() {
  const box = $('#as-locations');
  box.innerHTML = '';
  nas.locations.forEach((l, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${esc(l.label)}${l.type === 'city' ? `<select title="Radius">${[0, 10, 15, 25, 40, 50].map((r) => `<option value="${r}" ${Number(l.radius) === r ? 'selected' : ''}>${r ? `+${r} mi` : 'City only'}</option>`).join('')}</select>` : ''}<button type="button" title="Remove">×</button>`;
    $('select', chip)?.addEventListener('change', (e) => { l.radius = Number(e.target.value); });
    $('button', chip).addEventListener('click', () => { nas.locations.splice(i, 1); renderChips(); });
    box.appendChild(chip);
  });
}

async function geoSearch() {
  const q = $('#as-geo').value.trim();
  const list = $('#as-geo-results');
  if (q.length < 2) { list.hidden = true; return; }
  try {
    const results = await api(`/api/geo?q=${encodeURIComponent(q)}`);
    list.innerHTML = results.length
      ? results.map((r, i) => `<li data-i="${i}"><span>${esc(r.label)}</span><span class="type">${esc(r.type)}</span></li>`).join('')
      : '<li class="muted">No matches</li>';
    $$('li[data-i]', list).forEach((li) => li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const r = results[Number(li.dataset.i)];
      if (!nas.locations.some((l) => l.key === r.key)) nas.locations.push({ ...r, radius: r.type === 'city' ? 15 : undefined });
      renderChips();
      $('#as-geo').value = '';
      list.hidden = true;
    }));
    list.hidden = false;
  } catch (e) {
    list.innerHTML = `<li class="muted">${esc(e.message)}</li>`;
    list.hidden = false;
  }
}

async function submitAdset(e) {
  e.preventDefault();
  nasError('');
  const acc = nasAccount();
  const camp = nasCampaign();
  if (!camp) return nasError('Pick a campaign.');
  const body = {
    mode: nas.mode,
    campaignId: camp.id,
    name: $('#as-name').value,
    dailyBudget: $('#as-budget').value,
    status: nas.status,
  };
  if (nas.mode === 'copy') body.sourceAdsetId = $('#as-source').value;
  else {
    if (!body.name.trim()) return nasError('Give the ad set a name.');
    if (!nas.locations.length) return nasError('Add at least one location.');
    Object.assign(body, {
      pixelId: $('#as-pixel').value,
      event: $('#as-event').value,
      locations: nas.locations.map(({ key, type, radius }) => ({ key, type, radius })),
      ageMin: $('#as-age-min').value,
      ageMax: $('#as-age-max').value,
      gender: $('#as-gender').value,
      placements: $('#as-placements').value,
      advantageAudience: $('#as-advantage').checked,
    });
  }
  const btn = $('#as-submit');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const res = await fetch(`/api/accounts/${acc.id}/adsets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (Array.isArray(acc.adsets)) acc.adsets.push(data); else await loadAdsets(acc);
    setSelected({ acc, s: data }, true);
    openGroups.add(acc.id);
    $('#adset-dialog').close();
    toast(`Ad set "${data.name}" ${nas.mode === 'copy' ? 'copied (no ads)' : 'created'}, ${data.status === 'ACTIVE' ? 'active' : 'paused'} and selected`);
    renderTargets();
  } catch (err) {
    nasError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = nas.mode === 'copy' ? 'Copy ad set' : 'Create ad set';
  }
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 4000);
}

function initAdsetDialog() {
  const ages = Array.from({ length: 48 }, (_, i) => i + 18);
  $('#as-age-min').innerHTML = ages.map((a) => `<option value="${a}" ${a === 25 ? 'selected' : ''}>${a}</option>`).join('');
  $('#as-age-max').innerHTML = ages.map((a) => `<option value="${a}" ${a === 65 ? 'selected' : ''}>${a === 65 ? '65+' : a}</option>`).join('');
  $('#new-adset').addEventListener('click', () => openAdsetDialog());
  $('#as-account').addEventListener('change', () => nasLoadAccount());
  $('#as-campaign').addEventListener('change', nasCampaignChanged);
  $('#as-source').addEventListener('change', nasRender);
  $$('#as-mode button').forEach((b) => b.addEventListener('click', () => { nas.mode = b.dataset.mode; nasRender(); }));
  $$('#as-status button').forEach((b) => b.addEventListener('click', () => { nas.status = b.dataset.status; nasRender(); }));
  $('#as-geo').addEventListener('input', () => { clearTimeout(nas.geoTimer); nas.geoTimer = setTimeout(geoSearch, 250); });
  $('#as-geo').addEventListener('blur', () => setTimeout(() => { $('#as-geo-results').hidden = true; }, 150));
  $('#as-geo').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  $$('#adset-dialog [data-close]').forEach((b) => b.addEventListener('click', () => $('#adset-dialog').close()));
  $('#adset-form').addEventListener('submit', submitAdset);
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

// ---------- Performance ("Tristen performance" columns) ----------
const perf = {
  level: store.get('perfLevel', 'adset'),
  account: store.get('perfAccount', 'all'),
  date: store.get('perfDate', 'last_7d'),
  sort: store.get('perfSort', { key: 'spend', dir: -1 }),
  filter: null, // drill-down: { kind: 'account'|'campaign'|'adset', id, name }
  cache: new Map(),
  token: 0,
};
const ZERO_DEC = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD', 'COP', 'IDR', 'PYG']);
const LEVEL_NAMES = { account: 'Ad account', campaign: 'Campaign', adset: 'Ad set', ad: 'Ad' };

const fmtMoney = (v, cur) => (v === null || v === undefined || Number.isNaN(v) ? '—'
  : new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(v));
const fmtInt = (v) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('en-US').format(Math.round(v)));
const fmtPct = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(2)}%`);
const fmtDec = (v) => (v === null || v === undefined ? '—' : v.toFixed(2));

const DELIVERY = {
  ACTIVE: ['Active', 'on'], PAUSED: ['Off', ''], CAMPAIGN_PAUSED: ['Campaign off', ''], ADSET_PAUSED: ['Ad set off', ''],
  IN_PROCESS: ['Processing', 'warn'], WITH_ISSUES: ['Issues', 'bad'], PENDING_REVIEW: ['In review', 'warn'],
  DISAPPROVED: ['Rejected', 'bad'], PREAPPROVED: ['Approved', 'warn'], PENDING_BILLING_INFO: ['Billing issue', 'bad'],
};
const deliveryCell = (s) => {
  if (!s) return '<span class="muted">—</span>';
  const [label, cls] = DELIVERY[s] || [s.replace(/_/g, ' ').toLowerCase(), ''];
  return `<span class="dlv ${cls}">${esc(label)}</span>`;
};
const budgetCell = (b, cur) => {
  if (!b) return '<span class="muted">—</span>';
  const amt = b.amount / (ZERO_DEC.has(cur) ? 1 : 100);
  return `${fmtMoney(amt, cur)}<span class="sublbl">${b.campaign ? 'Campaign budget' : b.period === 'daily' ? 'Daily' : 'Lifetime'}</span>`;
};

// Columns in the same order as the Ads Manager preset.
const PERF_COLS = [
  { key: 'delivery', label: 'Delivery', text: true, sort: (r) => r.delivery || '', cell: (r) => deliveryCell(r.delivery) },
  { key: 'spend', label: 'Amount spent', money: true },
  { key: 'budget', label: 'Budget', sort: (r) => r.budget?.amount || 0, cell: (r) => budgetCell(r.budget, r.currency) },
  { key: 'actions', label: 'Actions', int: true },
  { key: 'cpm', label: 'CPM (cost per 1,000 impressions)', money: true },
  { key: 'frequency', label: 'Frequency', dec: true },
  { key: 'linkClicks', label: 'Link clicks', int: true },
  { key: 'costPerResult', label: 'Cost per result', money: true, sub: (r) => r.resultLabel && r.metrics.costPerResult !== null ? `Per ${r.resultLabel.replace(/s$/, '').toLowerCase()}` : '' },
  { key: 'results', label: 'Results', int: true, sub: (r) => r.resultLabel || '' },
  { key: 'costPer1kReached', label: 'Cost per 1,000 Meta accounts reached', money: true },
  { key: 'uniqueOutboundCtr', label: 'Unique outbound CTR', pct: true },
  { key: 'uniqueLinkCtr', label: 'Unique CTR (link)', pct: true },
  { key: 'costPerUniqueClick', label: 'Cost per unique click (all)', money: true },
  { key: 'costPerUniqueOutbound', label: 'Cost per unique outbound click', money: true },
  { key: 'costPerLpv', label: 'Cost per landing page view', money: true },
  { key: 'hookRate', label: 'Hook rate', pct: true },
  { key: 'holdRate', label: 'Hold rate', pct: true },
  { key: 'impressions', label: 'Impressions', int: true },
];

function metricCell(col, r) {
  if (col.cell) return col.cell(r);
  const v = r.metrics[col.key];
  const out = col.money ? fmtMoney(v, r.currency) : col.int ? fmtInt(v) : col.pct ? fmtPct(v) : fmtDec(v);
  const sub = col.sub ? col.sub(r) : '';
  return `${out}${sub ? `<span class="sublbl">${esc(sub)}</span>` : ''}`;
}

function perfRange() {
  if (perf.date === 'custom') {
    const since = $('#perf-since').value;
    const until = $('#perf-until').value;
    return since && until ? `since=${since}&until=${until}` : null;
  }
  return `date_preset=${perf.date}`;
}

function perfAccounts() {
  if (perf.filter?.kind === 'account') return state.accounts.filter((a) => a.id === perf.filter.id);
  return perf.account === 'all' ? state.accounts : state.accounts.filter((a) => a.id === perf.account);
}

async function loadPerformance(force = false) {
  const range = perfRange();
  const status = $('#perf-status');
  if (!range) { status.textContent = 'Pick both dates for a custom range.'; return; }
  const accounts = perfAccounts();
  const token = ++perf.token;
  const todo = accounts.filter((a) => force || !perf.cache.has(`${a.id}|${perf.level}|${range}`));
  let done = accounts.length - todo.length;
  const errors = [];
  status.className = 'perf-status';
  if (todo.length) status.textContent = `Loading ${done}/${accounts.length} accounts…`;
  renderPerformance();
  const queue = [...todo];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const a = queue.shift();
      try {
        perf.cache.set(`${a.id}|${perf.level}|${range}`, await api(`/api/accounts/${a.id}/performance?level=${perf.level}&${range}`));
      } catch (e) { errors.push(`${a.name}: ${e.message}`); }
      done++;
      if (token !== perf.token) return;
      status.textContent = `Loading ${done}/${accounts.length} accounts…`;
      renderPerformance();
    }
  }));
  if (token !== perf.token) return;
  status.className = `perf-status${errors.length ? ' bad' : ''}`;
  status.textContent = errors.length ? errors.join(' · ') : '';
  renderPerformance();
}

// Totals across accounts: additive numbers sum; rates are recomputed. Unique
// CTRs can't be summed, so they're reach-weighted (approximate) when several
// accounts are combined.
function combineTotals(list) {
  if (!list.length) return null;
  if (list.length === 1) return { ...list[0].total, currency: list[0].currency };
  const currencies = new Set(list.map((d) => d.currency));
  const raw = {};
  const keys = ['spend', 'impressions', 'reach', 'linkClicks', 'uniqueClicks', 'uniqueOutbound', 'landingPageViews', 'videoViews3s', 'thruplays', 'actions'];
  for (const k of keys) raw[k] = list.reduce((s, d) => s + (d.total?.raw?.[k] || 0), 0);
  const labels = new Set(list.map((d) => d.total?.resultLabel).filter(Boolean));
  raw.results = labels.size === 1 && list.every((d) => d.total?.raw?.results !== null) ? list.reduce((s, d) => s + (d.total?.raw?.results || 0), 0) : null;
  const weighted = (k) => (raw.reach ? list.reduce((s, d) => s + (d.total?.raw?.[k] || 0) * (d.total?.raw?.reach || 0), 0) / raw.reach : null);
  const m = {
    spend: raw.spend, actions: raw.actions, impressions: raw.impressions, reach: raw.reach, linkClicks: raw.linkClicks, results: raw.results,
    cpm: raw.impressions ? (raw.spend * 1000) / raw.impressions : null,
    frequency: raw.reach ? raw.impressions / raw.reach : null,
    costPerResult: raw.results ? raw.spend / raw.results : null,
    costPer1kReached: raw.reach ? (raw.spend * 1000) / raw.reach : null,
    uniqueOutboundCtr: weighted('uniqueOutboundCtr'),
    uniqueLinkCtr: weighted('uniqueLinkCtr'),
    costPerUniqueClick: raw.uniqueClicks ? raw.spend / raw.uniqueClicks : null,
    costPerUniqueOutbound: raw.uniqueOutbound ? raw.spend / raw.uniqueOutbound : null,
    costPerLpv: raw.landingPageViews ? raw.spend / raw.landingPageViews : null,
    hookRate: raw.videoViews3s ? (raw.videoViews3s * 100) / raw.impressions : null,
    holdRate: raw.videoViews3s ? (raw.thruplays * 100) / raw.impressions : null,
  };
  if (currencies.size > 1) for (const c of PERF_COLS) if (c.money) m[c.key] = null;
  return { metrics: m, resultLabel: labels.size === 1 ? [...labels][0] : null, currency: [...currencies][0], approx: true };
}

function renderPerformance() {
  $$('#perf-level button').forEach((b) => b.classList.toggle('active', b.dataset.level === perf.level));
  $('#perf-custom').hidden = perf.date !== 'custom';
  $('#perf-range-label').textContent = `· ${$('#perf-date').selectedOptions[0]?.textContent || ''}`;
  const chip = $('#perf-filter');
  chip.innerHTML = perf.filter ? `<span class="filter-chip">${esc(LEVEL_NAMES[perf.filter.kind])}: ${esc(perf.filter.name)} <button type="button" title="Clear">×</button></span>` : '';
  $('button', chip)?.addEventListener('click', () => { perf.filter = null; loadPerformance(); });

  const range = perfRange();
  const accounts = perfAccounts();
  const loaded = accounts.map((a) => perf.cache.get(`${a.id}|${perf.level}|${range}`)).filter(Boolean);
  const multi = accounts.length > 1;
  const q = $('#perf-search').value.trim().toLowerCase();
  const onlySpend = $('#perf-spend').checked;

  let rows = loaded.flatMap((d) => d.rows.map((r) => ({
    ...r,
    currency: d.currency,
    accountName: d.accountName,
    parent: perf.level === 'account' ? null : [multi ? d.accountName : null, r.parent].filter(Boolean).join(' · '),
  })));
  if (perf.filter?.kind === 'campaign') rows = rows.filter((r) => r.campaignId === perf.filter.id);
  if (perf.filter?.kind === 'adset') rows = rows.filter((r) => r.adsetId === perf.filter.id);
  if (onlySpend) rows = rows.filter((r) => r.metrics.spend > 0);
  if (q) rows = rows.filter((r) => [r.name, r.parent].some((t) => String(t || '').toLowerCase().includes(q)));

  const col = PERF_COLS.find((c) => c.key === perf.sort.key);
  const val = (r) => (perf.sort.key === 'name' ? r.name : col?.sort ? col.sort(r) : r.metrics[perf.sort.key]);
  rows.sort((a, b) => {
    const x = val(a); const y = val(b);
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return perf.sort.dir * (typeof x === 'string' ? byText(x, y) : x - y);
  });

  const arrow = (k) => (perf.sort.key === k ? (perf.sort.dir > 0 ? ' ↑' : ' ↓') : '');
  const drill = { account: 'campaign', campaign: 'adset', adset: 'ad' }[perf.level];
  const table = $('#perf-table');
  table.innerHTML = `<thead><tr>
      <th class="c-name ${perf.sort.key === 'name' ? 'sorted' : ''}" data-k="name">${LEVEL_NAMES[perf.level]}${arrow('name')}</th>
      ${PERF_COLS.map((c) => `<th class="${c.text ? 'c-text' : ''} ${perf.sort.key === c.key ? 'sorted' : ''}" data-k="${c.key}">${esc(c.label)}${arrow(c.key)}</th>`).join('')}
    </tr></thead>
    <tbody>${rows.map((r, i) => `<tr class="${r.noDelivery ? 'nodeliv' : ''}">
      <td class="c-name"><span class="nm ${drill ? 'link' : ''}" data-i="${i}" ${drill ? `title="Show its ${LEVEL_NAMES[drill].toLowerCase()}s"` : ''}>${esc(r.name)}</span>${r.parent ? `<span class="pr">${esc(r.parent)}</span>` : ''}</td>
      ${PERF_COLS.map((c) => `<td class="${c.text ? 'c-text' : ''}">${metricCell(c, r)}</td>`).join('')}
    </tr>`).join('')}</tbody>`;

  // Exact account totals unless the view is narrowed; then add up the rows shown.
  const narrowed = Boolean(perf.filter && perf.filter.kind !== 'account') || Boolean(q);
  const total = narrowed
    ? combineTotals(rows.map((r) => ({ total: { raw: r.raw, metrics: r.metrics, resultLabel: r.resultLabel }, currency: r.currency })))
    : combineTotals(loaded);
  const totalNote = narrowed ? 'Sum of rows shown · reach-based numbers approximate'
    : total?.approx ? 'All accounts in range · unique CTRs approximate' : `All ${LEVEL_NAMES[perf.level].toLowerCase()}s in range`;
  if (total && rows.length) {
    const t = { ...total, delivery: null, budget: null };
    table.insertAdjacentHTML('beforeend', `<tfoot><tr><td class="c-name">Total<span class="sublbl">${totalNote}</span></td>
      ${PERF_COLS.map((c) => `<td class="${c.text ? 'c-text' : ''}">${c.key === 'delivery' || c.key === 'budget' ? '' : metricCell(c, t)}</td>`).join('')}</tr></tfoot>`);
  }
  if (!rows.length) {
    table.insertAdjacentHTML('beforeend', `<tbody><tr><td class="c-name" colspan="${PERF_COLS.length + 1}" style="text-align:left;color:var(--muted)">${loaded.length < accounts.length ? 'Loading…' : onlySpend ? 'Nothing spent in this date range. Untick "Only rows with spend" to see everything.' : 'Nothing to show.'}</td></tr></tbody>`);
  }

  $$('thead th', table).forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.k;
    perf.sort = { key: k, dir: perf.sort.key === k ? -perf.sort.dir : (k === 'name' || k === 'delivery' ? 1 : -1) };
    store.set('perfSort', perf.sort);
    renderPerformance();
  }));
  if (drill) {
    $$('.nm.link', table).forEach((el) => el.addEventListener('click', () => {
      const r = rows[Number(el.dataset.i)];
      perf.filter = { kind: perf.level, id: perf.level === 'account' ? r.id.startsWith('act_') ? r.id : `act_${r.id}` : r.id, name: r.name };
      perf.level = drill;
      store.set('perfLevel', perf.level);
      loadPerformance();
    }));
  }
}

function showApp(which) {
  $$('.app-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.app === which));
  const isPerf = which === 'performance';
  $('#perf-view').hidden = !isPerf;
  $('#publish-view').hidden = isPerf;
  $('#publish-stepper').hidden = isPerf;
  $('#publish-bar').hidden = isPerf;
  document.body.classList.toggle('perf-mode', isPerf);
  store.set('app', which);
  if (isPerf && state.accounts.length) loadPerformance();
}

function initPerformance() {
  $('#perf-account').innerHTML = `<option value="all">All ad accounts (${state.accounts.length})</option>`
    + sortRows([...state.accounts], (a) => a.name).map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  if (perf.account !== 'all' && !state.accounts.some((a) => a.id === perf.account)) perf.account = 'all';
  $('#perf-account').value = perf.account;
  $('#perf-date').value = perf.date;
}

$$('.app-tabs button').forEach((b) => b.addEventListener('click', () => showApp(b.dataset.app)));
$$('#perf-level button').forEach((b) => b.addEventListener('click', () => {
  perf.level = b.dataset.level;
  perf.filter = null;
  store.set('perfLevel', perf.level);
  loadPerformance();
}));
$('#perf-account').addEventListener('change', (e) => { perf.account = e.target.value; perf.filter = null; store.set('perfAccount', perf.account); loadPerformance(); });
$('#perf-date').addEventListener('change', (e) => { perf.date = e.target.value; store.set('perfDate', perf.date); loadPerformance(); });
['#perf-since', '#perf-until'].forEach((s) => $(s).addEventListener('change', () => loadPerformance()));
$('#perf-search').addEventListener('input', renderPerformance);
$('#perf-spend').addEventListener('change', renderPerformance);
$('#perf-refresh').addEventListener('click', () => loadPerformance(true));

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
    initPerformance();
  } catch (e) {
    pill.textContent = 'Connection failed';
    pill.className = 'pill bad';
    state.loadError = true;
    $('#accounts').innerHTML = `<div class="alert">${esc(e.message)}</div>`;
    return;
  }
  renderTargets();
  if (store.get('app', 'publish') === 'performance') showApp('performance');
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
initAdsetDialog();
init().catch((e) => { $('#accounts').innerHTML = `<div class="alert">${esc(e.message)}</div>`; });
