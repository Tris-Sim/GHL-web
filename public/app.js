const $ = (sel, root = document) => root.querySelector(sel);
const state = { config: null, pages: [], accounts: [], selected: new Map(), drafts: [] };
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

function pageFor(accountId) {
  return pageChoices[accountId] || (state.pages[0] && state.pages[0].id) || '';
}

function renderAccounts() {
  const q = $('#account-search').value.trim().toLowerCase();
  const root = $('#accounts');
  if (!state.accounts.length) { root.innerHTML = '<p class="muted">No active ad accounts found for this token.</p>'; return; }
  root.innerHTML = '';
  for (const acc of state.accounts) {
    const adsets = acc.adsets || [];
    const matches = (s) => !q || s.toLowerCase().includes(q);
    const accMatches = matches(acc.name) || matches(acc.account_id);
    const visibleSets = adsets.filter((s) => accMatches || matches(s.name) || matches(s.campaign?.name || ''));
    if (q && !accMatches && !visibleSets.length) continue;

    const count = adsets.filter((s) => state.selected.has(s.id)).length;
    const el = document.createElement('div');
    el.className = 'account';
    el.innerHTML = `
      <div class="account-head">
        <span>${acc.open ? '▾' : '▸'}</span>
        <span class="name">${esc(acc.name)} <span class="muted">· ${esc(acc.account_id)} · ${esc(acc.currency)}</span></span>
        ${count ? `<span class="count">${count} selected</span>` : ''}
        <select title="Facebook Page used for ads in this account">
          ${state.pages.length ? '' : '<option value="">No pages available</option>'}
          ${state.pages.map((p) => `<option value="${p.id}" ${p.id === pageFor(acc.id) ? 'selected' : ''}>${esc(p.name)}${p.instagram_business_account ? ` + IG @${esc(p.instagram_business_account.username)}` : ''}</option>`).join('')}
        </select>
      </div>`;
    const head = $('.account-head', el);
    const select = $('select', el);
    select.addEventListener('click', (e) => e.stopPropagation());
    select.addEventListener('change', () => { pageChoices[acc.id] = select.value; store.set('pageChoices', pageChoices); updateSummary(); });
    head.addEventListener('click', () => toggleAccount(acc));

    if (acc.open || (q && acc.adsets)) {
      const box = document.createElement('div');
      box.className = 'adsets';
      if (acc.adsets === null) box.innerHTML = '<p class="muted">Loading ad sets…</p>';
      else if (acc.error) box.innerHTML = `<p class="errors">${esc(acc.error)}</p>`;
      else if (!adsets.length) box.innerHTML = '<p class="muted">No ad sets in this account. Create the campaign/ad set in Ads Manager first.</p>';
      else {
        const all = document.createElement('label');
        all.innerHTML = `<input type="checkbox" ${count === adsets.length ? 'checked' : ''}> <strong>Select all</strong>`;
        $('input', all).addEventListener('change', (e) => { adsets.forEach((s) => setSelected(acc, s, e.target.checked)); renderAccounts(); });
        box.appendChild(all);
        for (const s of visibleSets) {
          const row = document.createElement('label');
          row.innerHTML = `<input type="checkbox" ${state.selected.has(s.id) ? 'checked' : ''}>
            <span>${esc(s.name)} <span class="status">${esc(s.effective_status)}</span><br><span class="camp">${esc(s.campaign?.name || '')}</span></span>`;
          $('input', row).addEventListener('change', (e) => { setSelected(acc, s, e.target.checked); renderAccounts(); });
          box.appendChild(row);
        }
      }
      el.appendChild(box);
    }
    root.appendChild(el);
  }
}

function setSelected(acc, s, on) {
  if (on) state.selected.set(s.id, { accountId: acc.id, adsetId: s.id, adsetName: s.name });
  else state.selected.delete(s.id);
  updateSummary();
}

async function toggleAccount(acc) {
  acc.open = !acc.open;
  if (acc.open && acc.adsets === undefined) {
    acc.adsets = null;
    renderAccounts();
    try { acc.adsets = await api(`/api/accounts/${acc.id}/adsets`); } catch (e) { acc.adsets = []; acc.error = e.message; }
  }
  renderAccounts();
}

// ---------- Drafts ----------
const DRAFT_FIELDS = ['name', 'primaryText', 'headline', 'description', 'cta', 'link', 'urlTags'];
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
  const tbody = $('#results tbody');
  tbody.innerHTML = '';
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
        handleEvent(JSON.parse(buf.slice(0, nl)), tbody);
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

function handleEvent(e, tbody) {
  if (e.type === 'log') $('#log').textContent += `${e.message}\n`;
  if (e.type === 'fatal') { $('#errors').textContent = e.error; $('#errors').hidden = false; }
  if (e.type === 'done') $('#log').textContent += `\nDone: ${e.ok} succeeded, ${e.failed} failed.\n`;
  if (e.type !== 'result') return;
  const r = e.result;
  const d = state.drafts[r.draft] || {};
  const tr = document.createElement('tr');
  let cell;
  if (!r.ok) cell = `<td class="bad">Failed: ${esc(r.error)}</td>`;
  else if (r.preview) cell = `<td class="ok">Dry run<pre>${esc(JSON.stringify(r.preview, null, 2))}</pre></td>`;
  else {
    const notes = [];
    if (r.stillEnabled?.length) notes.push(`Meta still shows ON: ${r.stillEnabled.join(', ')} — check this ad in Ads Manager`);
    if (r.droppedFeatures?.length) notes.push(`Not accepted by Meta (skipped): ${r.droppedFeatures.join(', ')}`);
    if (r.verifyError) notes.push(`Could not verify enhancements: ${r.verifyError}`);
    cell = `<td class="ok">Created ad ${esc(r.adId)}${notes.map((n) => `<span class="warn">${esc(n)}</span>`).join('')}</td>`;
  }
  tr.innerHTML = `<td>${esc(d.name || d.headline)}</td><td>${esc(r.adsetName)}<br><span class="muted">${esc(r.accountId)}</span></td>${cell}`;
  tbody.appendChild(tr);
}

// ---------- Boot ----------
async function init() {
  state.config = await api('/api/config');
  $('#enh-count').textContent = state.config.optOutFeatures.length;
  $('#enh-list').innerHTML = state.config.optOutFeatures.map((f) => `<li>${esc(f)}</li>`).join('');
  state.drafts = store.get('drafts', []).map(newDraft);
  if (!state.drafts.length) state.drafts.push(newDraft());
  renderDrafts();

  const pill = $('#token-status');
  if (!state.config.tokenConfigured) {
    pill.textContent = 'No META_ACCESS_TOKEN set';
    pill.className = 'pill bad';
    $('#accounts').innerHTML = '<p class="errors">Add META_ACCESS_TOKEN to your .env file and restart the server.</p>';
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
  renderAccounts();
}

$('#add-draft').addEventListener('click', () => { state.drafts.push(newDraft()); saveDrafts(); renderDrafts(); });
$('#account-search').addEventListener('input', renderAccounts);
$('#publish').addEventListener('click', doPublish);
init().catch((e) => { $('#errors').textContent = e.message; $('#errors').hidden = false; });
