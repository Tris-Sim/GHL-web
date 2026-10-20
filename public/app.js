const $ = (sel, root = document) => root.querySelector(sel);
const state = { config: null, pages: [], accounts: [], selected: new Map(), drafts: [], results: [], publishedDrafts: [] };
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path) {
  const res = await fetch(path);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- Targets ----------
const pageChoices = store.get('pageChoices', {});
const openGroups = new Set(); // expanded account / campaign ids
state.view = store.get('view', 'account');
state.sort = store.get('sort', { key: 'name', dir: 1 });

function pageFor(accountId) {
  return pageChoices[accountId] || (state.pages[0] && state.pages[0].id) || '';
}

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
  $('#accounts').innerHTML = `<p class="muted">Loading ad sets from ${state.accounts.length} accounts…</p>`;
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

function pageSelect(acc) {
  const select = document.createElement('select');
  select.title = `Facebook Page used for ads in ${acc.name}`;
  select.innerHTML = (state.pages.length ? '' : '<option value="">No pages available</option>')
    + state.pages.map((p) => `<option value="${p.id}" ${p.id === pageFor(acc.id) ? 'selected' : ''}>${esc(p.name)}${p.instagram_business_account ? ` + IG @${esc(p.instagram_business_account.username)}` : ''}</option>`).join('');
  select.addEventListener('click', (e) => e.stopPropagation());
  select.addEventListener('change', () => { pageChoices[acc.id] = select.value; store.set('pageChoices', pageChoices); renderTargets(); });
  return select;
}

function adsetLine(row, { showCampaign = true, showAccount = false } = {}) {
  const { acc, s } = row;
  const label = document.createElement('label');
  label.className = 'adset-row';
  label.innerHTML = `<input type="checkbox" ${state.selected.has(s.id) ? 'checked' : ''}>
    <span>${esc(s.name)} <span class="status">${esc(s.effective_status)}</span>
    ${showCampaign || showAccount ? `<br><span class="camp">${[showCampaign && s.campaign?.name, showAccount && acc.name].filter(Boolean).map(esc).join(' · ')}</span>` : ''}</span>`;
  $('input', label).addEventListener('change', (e) => { setSelected(row, e.target.checked); renderTargets(); });
  return label;
}

function groupBlock({ id, title, meta, rows, extra, body }) {
  const el = document.createElement('div');
  el.className = 'account';
  const open = openGroups.has(id);
  const head = document.createElement('div');
  head.className = 'account-head';
  const count = rows.filter(({ s }) => state.selected.has(s.id)).length;
  head.innerHTML = `<span>${open ? '▾' : '▸'}</span>`;
  if (rows.length) head.appendChild(bulkBox(rows));
  head.insertAdjacentHTML('beforeend', `<span class="name">${esc(title)} <span class="muted">${meta}</span></span>${count ? `<span class="count">${count} selected</span>` : ''}`);
  if (extra) head.appendChild(extra);
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
  const accounts = sortRows([...state.accounts], (a) => a.name);
  for (const acc of accounts) {
    const rows = adsetRows().filter((r) => r.acc === acc);
    const accMatches = !q || [acc.name, acc.account_id].some((t) => String(t).toLowerCase().includes(q));
    if (q && !accMatches && !rows.length) continue;
    const shown = accMatches && !q ? (acc.adsets || []).map((s) => ({ acc, s })) : rows;
    root.appendChild(groupBlock({
      id: acc.id,
      title: acc.name,
      meta: `· ${esc(acc.account_id)} · ${esc(acc.currency)}${acc.adsets ? ` · ${acc.adsets.length} ad sets` : ''}`,
      rows: shown,
      extra: pageSelect(acc),
      body: {
        onOpen: () => loadAdsets(acc),
        render(box) {
          if (acc.adsets === null) box.innerHTML = '<p class="muted">Loading ad sets…</p>';
          else if (acc.error) box.innerHTML = `<p class="errors">${esc(acc.error)}</p>`;
          else if (!shown.length) box.innerHTML = '<p class="muted">No ad sets in this account. Create the campaign/ad set in Ads Manager first.</p>';
          else {
            const camps = groupBy(shown, (r) => r.s.campaign?.id || 'none');
            for (const camp of sortRows([...camps.values()], (rs) => rs[0].s.campaign?.name)) {
              const h = document.createElement('label');
              h.className = 'camp-head';
              h.appendChild(bulkBox(camp));
              h.insertAdjacentHTML('beforeend', `<strong>${esc(camp[0].s.campaign?.name || 'No campaign')}</strong> <span class="muted">${esc(camp[0].s.campaign?.objective || '')}</span>`);
              box.appendChild(h);
              for (const r of sortRows(camp, (x) => x.s.name)) box.appendChild(adsetLine(r, { showCampaign: false })).classList.add('nested');
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
      meta: `· ${esc(acc.name)} · ${rows.length} ad set${rows.length === 1 ? '' : 's'}`,
      rows,
      extra: pageSelect(acc),
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
  th0.appendChild(bulkBox(rows));
  head.appendChild(th0);
  for (const [key, label] of cols) {
    const th = document.createElement('th');
    th.className = 'sortable';
    th.textContent = label + (state.sort.key === key ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : '');
    th.addEventListener('click', () => { state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 }; store.set('sort', state.sort); renderTargets(); });
    head.appendChild(th);
  }
  table.createTHead().appendChild(head);
  const tbody = table.createTBody();
  for (const r of rows) {
    const tr = tbody.insertRow();
    tr.innerHTML = `<td><input type="checkbox" ${state.selected.has(r.s.id) ? 'checked' : ''}></td><td>${esc(r.s.name)}</td><td>${esc(r.s.campaign?.name)}</td><td>${esc(r.acc.name)}</td><td class="status">${esc(r.s.effective_status)}</td>`;
    $('input', tr).addEventListener('change', (e) => { setSelected(r, e.target.checked); renderTargets(); });
  }
  root.appendChild(table);
  if (!rows.length) root.insertAdjacentHTML('beforeend', '<p class="muted">No ad sets match.</p>');
}

async function renderTargets() {
  const q = $('#account-search').value.trim().toLowerCase();
  const root = $('#accounts');
  document.querySelectorAll('#view-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  $('#sort-dir').textContent = state.sort.dir > 0 ? 'A → Z' : 'Z → A';
  updateSummary();
  if (!state.accounts.length) { root.innerHTML = '<p class="muted">No active ad accounts found for this token.</p>'; return; }
  if (state.view !== 'account') await loadAllAdsets();
  root.innerHTML = '';
  if (state.view === 'campaign') renderByCampaign(root);
  else if (state.view === 'adset') renderByAdset(root);
  else renderByAccount(root, q);
  if (state.view !== 'account' && !root.children.length) root.innerHTML = '<p class="muted">No campaigns match.</p>';
}

// ---------- Drafts ----------
const DRAFT_FIELDS = ['name', 'primaryText', 'headline', 'description', 'cta', 'link', 'displayLink', 'urlTags'];

// Websites you've published to before, offered as suggestions in the destination field.
function renderWebsites() {
  $('#websites').innerHTML = store.get('websites', []).map((u) => `<option value="${esc(u)}">`).join('');
}
function rememberWebsites() {
  const seen = store.get('websites', []);
  const used = state.drafts.map((d) => (d.link || '').trim()).filter((u) => /^https?:\/\//i.test(u));
  store.set('websites', [...new Set([...used, ...seen])].slice(0, 30));
  renderWebsites();
}
const saveDrafts = () => store.set('drafts', state.drafts.map(({ file, ...d }) => d));

function newDraft(from = {}) {
  const d = { cta: 'LEARN_MORE', ...from };
  delete d.file;
  if (from.file) d.file = from.file;
  return d;
}

function renderDrafts() {
  const root = $('#drafts');
  root.innerHTML = '';
  state.drafts.forEach((d, i) => {
    const el = $('#draft-tpl').content.firstElementChild.cloneNode(true);
    $('.draft-num', el).textContent = `Ad ${i + 1}`;
    $('[data-f="cta"]', el).innerHTML = state.config.ctaTypes.map((c) => `<option value="${c}">${c.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (x) => x.toUpperCase())}</option>`).join('');
    for (const f of DRAFT_FIELDS) {
      const input = $(`[data-f="${f}"]`, el);
      input.value = d[f] || '';
      input.addEventListener('input', () => { d[f] = input.value; saveDrafts(); });
    }
    const file = $('[data-f="media"]', el);
    file.addEventListener('change', () => { d.file = file.files[0]; showPreview(el, d); updateSummary(); });
    showPreview(el, d);
    $('.dup', el).addEventListener('click', () => { state.drafts.splice(i + 1, 0, newDraft({ ...d, name: d.name ? `${d.name} copy` : '' })); saveDrafts(); renderDrafts(); });
    $('.remove', el).addEventListener('click', () => { state.drafts.splice(i, 1); if (!state.drafts.length) state.drafts.push(newDraft()); saveDrafts(); renderDrafts(); });
    root.appendChild(el);
  });
  updateSummary();
}

function showPreview(el, d) {
  const box = $('.preview', el);
  if (!d.file) { box.innerHTML = ''; return; }
  const url = URL.createObjectURL(d.file);
  box.innerHTML = d.file.type.startsWith('video/')
    ? `<video src="${url}" controls muted></video>`
    : `<img src="${url}" alt="">`;
  box.insertAdjacentHTML('beforeend', `<div class="fname">${esc(d.file.name)}</div>`);
  $('.drop span', el).textContent = 'Change file';
}

// ---------- Publish ----------
function targets() {
  return [...state.selected.values()].map((t) => {
    const page = state.pages.find((p) => p.id === pageFor(t.accountId));
    return { ...t, pageId: page?.id, instagramUserId: page?.instagram_business_account?.id };
  });
}

function updateSummary() {
  const n = state.drafts.length;
  const m = state.selected.size;
  const accounts = new Set([...state.selected.values()].map((t) => t.accountId)).size;
  $('#summary').textContent = m
    ? `${n} ad${n === 1 ? '' : 's'} × ${m} ad set${m === 1 ? '' : 's'} across ${accounts} account${accounts === 1 ? '' : 's'} = ${n * m} ads to create`
    : 'Select at least one ad set above.';
}

async function doPublish() {
  const btn = $('#publish');
  const errors = $('#errors');
  errors.hidden = true;
  const dryRun = $('#dry-run').checked;
  const status = document.querySelector('input[name="status"]:checked').value;
  const ts = targets();
  if (!dryRun && status === 'ACTIVE' && !confirm(`Create ${state.drafts.length * ts.length} ads and set them LIVE now? They will start spending.`)) return;

  const form = new FormData();
  form.append('payload', JSON.stringify({
    drafts: state.drafts.map(({ file, ...d }) => d),
    targets: ts,
    status,
    dryRun,
  }));
  state.drafts.forEach((d, i) => { if (d.file) form.append(`media_${i}`, d.file); });

  btn.disabled = true;
  btn.textContent = dryRun ? 'Building preview…' : 'Publishing…';
  state.results = [];
  state.publishedDrafts = state.drafts.map((d) => d.name || d.headline);
  rememberWebsites();
  renderResults();
  $('#log').textContent = '';
  $('#results').hidden = false;

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
    errors.textContent = e.message;
    errors.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Publish';
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

function resultCell(r) {
  if (!r.ok) return `<td class="bad">Failed: ${esc(r.error)}</td>`;
  if (r.preview) return `<td class="ok">Dry run<pre>${esc(JSON.stringify(r.preview, null, 2))}</pre></td>`;
  const notes = [];
  if (r.stillEnabled?.length) notes.push(`Meta still shows ON: ${r.stillEnabled.join(', ')} — check this ad in Ads Manager`);
  if (r.droppedFeatures?.length) notes.push(`Not accepted by Meta (skipped): ${r.droppedFeatures.join(', ')}`);
  if (r.verifyError) notes.push(`Could not verify enhancements: ${r.verifyError}`);
  return `<td class="ok">Created ad ${esc(r.adId)}${notes.map((n) => `<span class="warn">${esc(n)}</span>`).join('')}</td>`;
}

function renderResults() {
  const groupBy = $('#group-by').value;
  const key = RESULT_GROUPS[groupBy];
  const rows = state.results.map((r) => ({ ...r, adName: state.publishedDrafts[r.draft] }));
  const groups = new Map();
  for (const r of rows) { const k = key(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const tbody = $('#results tbody');
  tbody.innerHTML = '';
  for (const k of [...groups.keys()].sort(byText)) {
    const rs = groups.get(k);
    const ok = rs.filter((r) => r.ok).length;
    tbody.insertAdjacentHTML('beforeend', `<tr class="group"><td colspan="3">${esc(k)} <span class="muted">· ${ok}/${rs.length} ok</span></td></tr>`);
    for (const r of rs) {
      const where = [groupBy !== 'account' && (r.accountName || r.accountId), groupBy !== 'campaign' && r.campaignName, groupBy !== 'adset' && r.adsetName].filter(Boolean);
      tbody.insertAdjacentHTML('beforeend', `<tr><td>${esc(r.adName)}</td><td>${where.map(esc).join('<br>')}</td>${resultCell(r)}</tr>`);
    }
  }
  const ok = rows.filter((r) => r.ok).length;
  $('#result-counts').textContent = `${ok} succeeded · ${rows.length - ok} failed`;
}

// ---------- Boot ----------
async function init() {
  state.config = await api('/api/config');
  $('#enh-count').textContent = state.config.optOutFeatures.length;
  $('#enh-list').innerHTML = state.config.optOutFeatures.map((f) => `<li>${esc(f)}</li>`).join('');
  state.drafts = store.get('drafts', []).map(newDraft);
  if (!state.drafts.length) state.drafts.push(newDraft());
  $('#group-by').value = store.get('groupBy', 'account');
  renderWebsites();
  renderDrafts();

  const pill = $('#token-status');
  if (!state.config.tokenConfigured) {
    pill.textContent = 'No META_ACCESS_TOKEN set';
    pill.className = 'pill bad';
    $('#accounts').innerHTML = `<p class="errors">${esc(state.config.tokenProblem || 'Add META_ACCESS_TOKEN to your .env file')}\nFix it, then stop the server (Ctrl + C) and run npm start again.</p>`;
    return;
  }
  try {
    const [accounts, pages] = await Promise.all([api('/api/accounts'), api('/api/pages')]);
    state.accounts = accounts;
    state.pages = pages;
    pill.textContent = `Connected · ${accounts.length} ad accounts · Graph ${state.config.apiVersion}`;
    pill.className = 'pill ok';
  } catch (e) {
    pill.textContent = 'Meta connection failed';
    pill.className = 'pill bad';
    $('#accounts').innerHTML = `<p class="errors">${esc(e.message)}</p>`;
    return;
  }
  renderTargets();
}

$('#add-draft').addEventListener('click', () => { state.drafts.push(newDraft()); saveDrafts(); renderDrafts(); });
$('#account-search').addEventListener('input', renderTargets);
document.querySelectorAll('#view-tabs button').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  store.set('view', state.view);
  if (state.view !== 'adset') state.sort = { key: 'name', dir: state.sort.dir };
  renderTargets();
}));
$('#sort-dir').addEventListener('click', () => { state.sort.dir = -state.sort.dir; store.set('sort', state.sort); renderTargets(); });
$('#publish').addEventListener('click', doPublish);
$('#group-by').addEventListener('change', () => { store.set('groupBy', $('#group-by').value); renderResults(); });
init().catch((e) => { $('#errors').textContent = e.message; $('#errors').hidden = false; });
