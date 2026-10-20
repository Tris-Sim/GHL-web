// Thin Meta Graph API client. Uses Node's built-in fetch / FormData.
const API_VERSION = process.env.META_API_VERSION || 'v26.0';
const BASE = `https://graph.facebook.com/${API_VERSION}`;
// Video uploads must go to Meta's video host; graph.facebook.com rejects large bodies (HTTP 413).
const VIDEO_BASE = `https://graph-video.facebook.com/${API_VERSION}`;

class GraphError extends Error {
  constructor(err, status) {
    const msg = [err.message, err.error_user_title, err.error_user_msg].filter(Boolean).join(' — ');
    super(msg || (status === 413
      ? 'Meta rejected the upload as too large (HTTP 413)'
      : `Graph API error (HTTP ${status})`));
    this.graph = err;
    this.status = status;
  }
}

function createClient(token, { fetchImpl = fetch } = {}) {
  if (!token) throw new Error('META_ACCESS_TOKEN is not set');

  async function call(method, path, params = {}, body, { video = false } = {}) {
    const url = new URL(path.startsWith('http') ? path : `${video ? VIDEO_BASE : BASE}/${path.replace(/^\//, '')}`);
    if (!path.startsWith('http')) url.searchParams.set('access_token', token);
    const init = { method };
    if (method === 'GET') {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    } else if (body) {
      init.body = body; // FormData — fetch sets the multipart boundary
    } else {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        form.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
      init.body = form;
    }
    const res = await fetchImpl(url, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new GraphError(data.error || {}, res.status);
    return data;
  }

  // Follows paging.next until exhausted (capped to avoid runaway loops).
  async function getAll(path, params, max = 2000) {
    let page = await call('GET', path, { limit: '200', ...params });
    const out = [...(page.data || [])];
    while (page.paging && page.paging.next && out.length < max) {
      page = await call('GET', page.paging.next);
      out.push(...(page.data || []));
    }
    return out;
  }

  return {
    get: (path, params) => call('GET', path, params),
    post: (path, params, opts) => call('POST', path, params, undefined, opts),
    postForm: (path, form, opts) => call('POST', path, {}, form, opts),
    getAll,
  };
}

module.exports = { createClient, GraphError, API_VERSION };
