/* =====================================================================
   FAMILY VAULT — the app
   ===================================================================== */
(() => {
  'use strict';

  const C = window.FV_CONFIG || {};
  const D = window.FVDetect;
  const BUCKET = 'fv-docs';
  const MAX_FILE = 50 * 1024 * 1024;           // Supabase free plan limit per file
  const SOON_DAYS = 60;                        // warn this many days before something expires
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  const TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

  // ---------- tiny helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now() + Math.random().toString(16).slice(2));
  const fmtSize = n => n == null ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  const fmtDate = s => { if (!s) return ''; const d = new Date(s.length === 10 ? s + 'T00:00:00' : s); return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); };
  const daysUntil = iso => Math.round((new Date(iso + 'T00:00:00') - new Date(new Date().toDateString())) / 86400000);
  const lettersIn = s => (String(s || '').match(/[A-Za-z]/g) || []).length;
  const pref = (k, def) => { try { const v = localStorage.getItem('fv_' + k); return v == null ? def : JSON.parse(v); } catch { return def; } };
  const setPref = (k, v) => { try { localStorage.setItem('fv_' + k, JSON.stringify(v)); } catch { /* private window */ } };
  const ICON = {
    docs: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></svg>',
    add: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
    family: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.4"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6M14.5 14.6c.8-.4 1.6-.6 2.5-.6 2.5 0 4 2 4 5"/></svg>',
    key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/></svg>',
    more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
    lock: '<svg viewBox="0 0 24 24" class="i-lock"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
    camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    folder: '<svg viewBox="0 0 24 24"><path d="M3 6h6l2 2h10v11H3z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };

  // ---------- state ----------
  const S = {
    sb: null, user: null, me: null, members: [], users: [],
    view: 'docs', q: '', filterMember: '', filterType: '', selecting: false, selected: new Set(),
    docs: [], allDocs: [], urls: new Map(),
    batch: null,
    vault: { key: null, items: [], meta: undefined, timer: null, filter: '' }
  };
  const canUpload = () => S.me && ['uploader', 'admin'].includes(S.me.role);
  const isAdmin = () => S.me && S.me.role === 'admin';
  const memberById = id => S.members.find(m => m.id === id);

  // ---------- toast / sheet ----------
  let toastTimer;
  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 3000);
  }
  function openSheet(html) {
    const s = $('#sheet');
    s.innerHTML = `<div class="sheet-back" data-act="closeSheet"></div><div class="sheet-body">${html}</div>`;
    s.hidden = false; document.body.classList.add('no-scroll');
  }
  function closeSheet() { const s = $('#sheet'); s.hidden = true; s.innerHTML = ''; document.body.classList.remove('no-scroll'); }
  function niceError(e) {
    const m = (e && (e.message || e.error_description || e.msg)) || String(e || 'Something went wrong');
    if (/Invalid login credentials/i.test(m)) return 'Wrong mobile number or password.';
    if (/already registered|already been registered/i.test(m)) return 'This mobile number already has a login — sign in instead.';
    if (/Password should be/i.test(m)) return 'Password must be at least 6 characters.';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'No internet connection — please try again.';
    if (/row-level security|permission denied/i.test(m)) return 'You do not have permission to do that.';
    if (/Email not confirmed/i.test(m)) return 'Supabase is asking to confirm this login by email. Ask the admin to switch off "Confirm email" in Supabase (see setup steps).';
    if (/exceeded the maximum allowed size|Payload too large/i.test(m)) return 'This file is too big for your storage plan.';
    return m;
  }

  // ---------- scripts loaded only when needed ----------
  const loaded = {};
  function loadScript(src) {
    if (!loaded[src]) loaded[src] = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.onload = res;
      s.onerror = () => { delete loaded[src]; rej(new Error('Could not load a reading tool — check the internet connection.')); };
      document.head.appendChild(s);
    });
    return loaded[src];
  }
  async function pdfjs() {
    await loadScript(PDFJS + 'pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
    return window.pdfjsLib;
  }
  let ocrWorker = null, ocrLang = '';
  async function ocr(canvas) {
    const lang = pref('hindi', false) ? 'eng+hin' : 'eng';
    if (!ocrWorker || ocrLang !== lang) {
      await loadScript(TESS);
      if (ocrWorker) { try { await ocrWorker.terminate(); } catch { /* ignore */ } }
      ocrWorker = await window.Tesseract.createWorker(lang);
      ocrLang = lang;
    }
    const { data } = await ocrWorker.recognize(canvas);
    return data.text || '';
  }

  // =====================================================================
  //  Start-up and login
  // =====================================================================
  function configMissing() {
    return !C.SUPABASE_URL || /PASTE/.test(C.SUPABASE_URL) || !C.SUPABASE_KEY || /PASTE/.test(C.SUPABASE_KEY) ||
      !C.LOGIN_EMAIL || /PASTE/.test(C.LOGIN_EMAIL) || !/@/.test(C.LOGIN_EMAIL);
  }
  function loginEmail(mobile) {
    const [local, domain] = C.LOGIN_EMAIL.trim().toLowerCase().split('@');
    return `${local.split('+')[0]}+fv${mobile}@${domain}`;
  }
  const cleanMobile = v => String(v || '').replace(/\D/g, '').slice(-10);

  async function boot() {
    document.title = C.APP_NAME || 'Family Vault';
    if (!window.supabase || !D) return renderPlain('<h2>Could not start</h2><p>The app could not load its parts. Check the internet connection and reload.</p>');
    if (configMissing()) return renderPlain(`<h2>One more step</h2><p>Open <b>config.js</b> on GitHub and paste in your Supabase Project URL, the anon/publishable key and your Gmail address, then reload this page.</p>`);
    S.sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
    const { data } = await S.sb.auth.getSession();
    if (data.session) { S.user = data.session.user; await afterLogin(); }
    else renderLogin();
  }
  function renderPlain(html) { $('#app').innerHTML = `<div class="center-card card">${html}</div>`; }

  function renderLogin(mode = 'in', msg = '') {
    const up = mode === 'up';
    $('#app').innerHTML = `
      <div class="login">
        <div class="brand"><div class="logo">${ICON.lock}</div><h1>${esc(C.APP_NAME || 'Family Vault')}</h1><p>Your family's documents, in one safe place.</p></div>
        <form class="card form" id="loginForm" autocomplete="on">
          <h2>${up ? 'Create your login' : 'Sign in'}</h2>
          ${up ? `<label>Your name<input name="name" required autocomplete="name" placeholder="e.g. Diansh"></label>` : ''}
          <label>Mobile number<input name="mobile" required inputmode="numeric" autocomplete="tel" placeholder="10-digit mobile number"></label>
          <label>Password<input name="password" type="password" required minlength="6" autocomplete="${up ? 'new-password' : 'current-password'}"></label>
          ${up ? `<label>Type the password again<input name="password2" type="password" required minlength="6" autocomplete="new-password"></label>` : ''}
          ${msg ? `<p class="msg bad">${esc(msg)}</p>` : ''}
          <button class="btn primary big" type="submit">${up ? 'Create login' : 'Sign in'}</button>
          <p class="switch">${up ? 'Already have a login?' : 'New in the family?'}
            <a href="#" data-act="${up ? 'showSignIn' : 'showSignUp'}">${up ? 'Sign in' : 'Create a login'}</a></p>
          ${up ? '<p class="hint">The first login ever created becomes the admin. Everyone after that waits until the admin lets them in.</p>' : ''}
        </form>
      </div>`;
    $('#loginForm').onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const mobile = cleanMobile(f.get('mobile'));
      const password = f.get('password');
      const btn = e.target.querySelector('button[type=submit]');
      if (mobile.length !== 10) return renderLogin(mode, 'Please enter a 10-digit mobile number.');
      if (up && password !== f.get('password2')) return renderLogin(mode, 'The two passwords do not match.');
      btn.disabled = true; btn.textContent = 'Please wait…';
      try {
        if (up) {
          const name = String(f.get('name') || '').trim();
          const { data, error } = await S.sb.auth.signUp({ email: loginEmail(mobile), password, options: { data: { name, mobile } } });
          if (error) throw error;
          if (!data.session) throw new Error('Email not confirmed');
          S.user = data.session.user;
        } else {
          const { data, error } = await S.sb.auth.signInWithPassword({ email: loginEmail(mobile), password });
          if (error) throw error;
          S.user = data.user;
        }
        await afterLogin();
      } catch (err) { renderLogin(mode, niceError(err)); }
    };
  }

  async function afterLogin() {
    // 2-step login: ask for the authenticator code if this login has it switched on
    try {
      const { data: aal } = await S.sb.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') return renderMfaPrompt();
    } catch { /* older projects without 2-step login */ }

    let { data: me, error } = await S.sb.from('fv_users').select('*').eq('user_id', S.user.id).maybeSingle();
    if (error) return renderPlain(`<h2>Database not set up</h2><p>${esc(niceError(error))}</p><p>Run <b>setup.sql</b> in the Supabase SQL Editor, then reload.</p><button class="btn" data-act="signOut">Sign out</button>`);
    if (!me) {
      const meta = S.user.user_metadata || {};
      const mobile = meta.mobile || ((S.user.email || '').match(/\+fv(\d{10})@/) || [])[1] || '';
      const { error: e2 } = await S.sb.rpc('fv_register', { p_name: meta.name || 'Family member', p_mobile: mobile });
      if (e2) return renderPlain(`<h2>Could not finish sign-up</h2><p>${esc(niceError(e2))}</p><button class="btn" data-act="signOut">Sign out</button>`);
      ({ data: me } = await S.sb.from('fv_users').select('*').eq('user_id', S.user.id).maybeSingle());
    }
    S.me = me;
    if (!me || me.role === 'pending') return renderPending();
    await loadMembers();
    if (isAdmin()) loadUsers();
    go(S.view || 'docs');
  }

  function renderPending() {
    $('#app').innerHTML = `<div class="center-card card">
      <div class="logo small">${ICON.lock}</div>
      <h2>Waiting for the admin</h2>
      <p>Your login is made. The family admin needs to let you in — ask them to open <b>More → Family logins</b> and give you access.</p>
      <div class="row gap"><button class="btn primary" data-act="recheck">Check again</button><button class="btn" data-act="signOut">Sign out</button></div>
    </div>`;
  }

  function renderMfaPrompt(msg = '') {
    $('#app').innerHTML = `<div class="center-card card">
      <div class="logo small">${ICON.lock}</div>
      <h2>Enter your 6-digit code</h2>
      <p>Open your authenticator app (Google Authenticator) and type the code shown for ${esc(C.APP_NAME || 'Family Vault')}.</p>
      <form id="mfaForm" class="form"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" class="code-input" required>
      ${msg ? `<p class="msg bad">${esc(msg)}</p>` : ''}
      <button class="btn primary big">Continue</button></form>
      <p class="switch"><a href="#" data-act="signOut">Sign out</a></p></div>`;
    $('#mfaForm').onsubmit = async e => {
      e.preventDefault();
      const code = new FormData(e.target).get('code').replace(/\D/g, '');
      try {
        const { data } = await S.sb.auth.mfa.listFactors();
        const f = (data.totp || []).find(x => x.status === 'verified');
        if (!f) throw new Error('No authenticator found for this login.');
        const { error } = await S.sb.auth.mfa.challengeAndVerify({ factorId: f.id, code });
        if (error) throw error;
        await afterLogin();
      } catch (err) { renderMfaPrompt(/invalid/i.test(err.message) ? 'That code is wrong or expired — try the new one.' : niceError(err)); }
    };
  }

  async function loadMembers() {
    const { data } = await S.sb.from('fv_members').select('*').order('created_at');
    S.members = data || [];
  }
  async function loadUsers() {
    const { data } = await S.sb.from('fv_users').select('*').order('created_at');
    S.users = data || [];
  }

  // =====================================================================
  //  Layout
  // =====================================================================
  function go(view) {
    if (S.batch && S.batch.phase === 'reading' && view !== 'add') {
      if (!confirm('Files are still being read. Leave this screen? (Reading carries on in the background.)')) return;
    }
    S.view = view;
    window.scrollTo(0, 0);
    renderShell();
  }
  function renderShell() {
    const tabs = [['docs', 'Documents', ICON.docs]];
    if (canUpload()) tabs.push(['add', 'Add', ICON.add]);
    tabs.push(['family', 'Family', ICON.family], ['vault', 'Passwords', ICON.key], ['more', 'More', ICON.more]);
    $('#app').innerHTML = `
      <header class="top"><div class="top-in">
        <div class="brand-sm"><span class="logo tiny">${ICON.lock}</span>${esc(C.APP_NAME || 'Family Vault')}</div>
        <div class="me">${esc(S.me.display_name)}</div></div></header>
      <main id="main" class="main"></main>
      <nav class="tabs">${tabs.map(([k, l, i]) => `<button class="tab ${S.view === k ? 'on' : ''}" data-act="go" data-v="${k}">${i}<span>${l}</span></button>`).join('')}</nav>`;
    ({ docs: viewDocs, add: viewAdd, family: viewFamily, vault: viewVault, more: viewMore }[S.view] || viewDocs)();
  }
  const main = () => $('#main');

  // =====================================================================
  //  Documents: search and browse
  // =====================================================================
  async function viewDocs() {
    main().innerHTML = `
      <div id="expBanner"></div>
      <div class="searchbar">${ICON.search}<input id="q" type="search" placeholder="Search names, numbers, any word inside…" value="${esc(S.q)}" autocomplete="off">
        ${S.q ? `<button class="icon-btn" data-act="clearQ" aria-label="Clear">${ICON.close}</button>` : ''}</div>
      <div class="chips">
        <button class="chip ${!S.filterMember ? 'on' : ''}" data-act="filterMember" data-id="">Everyone</button>
        ${S.members.map(m => `<button class="chip ${S.filterMember === m.id ? 'on' : ''}" data-act="filterMember" data-id="${m.id}">${esc(m.name)}</button>`).join('')}
      </div>
      <div class="row between small-gap"><span id="count" class="muted"></span>
        <span class="row small-gap"><select id="typeFilter" class="select-sm"><option value="">All kinds</option>${typeOptions(S.filterType)}</select>
        <button class="btn small" data-act="toggleSelecting">${S.selecting ? 'Done' : 'Select'}</button></span></div>
      ${S.selecting ? '<p class="muted small">Tap documents to pick them, then send them together.</p>' : ''}
      <div id="results" class="list"><div class="muted pad">Loading…</div></div>
      <div id="selBar"></div>`;
    let t;
    $('#q').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { S.q = e.target.value; runSearch(); }, 300); });
    $('#typeFilter').addEventListener('change', e => { S.filterType = e.target.value; runSearch(); });
    await runSearch();
    loadExpiring();
  }
  function typeOptions(sel, extra) {
    const list = [...new Set(D.DOC_TYPES.concat(extra ? [extra] : []))];
    return list.map(t => `<option ${t === sel ? 'selected' : ''}>${esc(t)}</option>`).join('');
  }

  let searchSeq = 0;
  async function runSearch() {
    const seq = ++searchSeq;
    const { data, error } = await S.sb.rpc('fv_search', { q: S.q || '', p_member: S.filterMember || null, p_type: S.filterType || null });
    if (seq !== searchSeq || S.view !== 'docs') return;
    const box = $('#results');
    if (error) { box.innerHTML = `<p class="msg bad">${esc(niceError(error))}</p>`; return; }
    S.docs = data || [];
    $('#count').textContent = S.docs.length === 300 ? 'Showing first 300' : `${S.docs.length} document${S.docs.length === 1 ? '' : 's'}`;
    if (!S.docs.length) {
      box.innerHTML = S.q ? `<div class="empty">Nothing matches “${esc(S.q)}”.</div>`
        : `<div class="empty"><p>No documents yet.</p>${canUpload() ? '<button class="btn primary" data-act="go" data-v="add">Add your first document</button>' : ''}</div>`;
      return;
    }
    const words = (S.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    box.innerHTML = S.docs.map(d => docCard(d, words)).join('');
    fillThumbs(S.docs);
    renderSelBar();
  }
  function renderSelBar() {
    const bar = $('#selBar');
    if (!bar) return;
    const n = S.selected.size;
    bar.innerHTML = S.selecting && n ? `<div class="savebar"><button class="btn primary big" data-act="sendSelected">Send ${n} document${n === 1 ? '' : 's'}</button></div>` : '';
  }

  function highlight(text, words) {
    let h = esc(text);
    for (const w of words) {
      if (w.length < 2) continue;
      h = h.replace(new RegExp('(' + esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>');
    }
    return h;
  }
  function expiryBadge(iso) {
    if (!iso) return '';
    const n = daysUntil(iso);
    if (n < 0) return `<span class="badge red">Expired ${fmtDate(iso)}</span>`;
    if (n <= SOON_DAYS) return `<span class="badge amber">Expires in ${n} day${n === 1 ? '' : 's'}</span>`;
    return '';
  }
  function docCard(d, words = []) {
    const sel = S.selecting;
    return `<button class="doc ${sel && S.selected.has(d.id) ? 'picked' : ''}" data-act="${sel ? 'toggleSel' : 'openDoc'}" data-id="${d.id}">
      ${sel ? `<span class="pick">${S.selected.has(d.id) ? '✓' : ''}</span>` : ''}
      <div class="thumb" data-thumb="${esc(d.thumb_path || '')}">${thumbFallback(d.mime_type)}</div>
      <div class="doc-body">
        <div class="doc-title">${d.is_private ? ICON.lock : ''}${highlight(d.title, words)}</div>
        <div class="doc-meta">${esc([d.member_name, d.doc_type].filter(Boolean).join(' · '))}${d.created_at ? ' · ' + fmtDate(d.created_at) : ''}</div>
        ${d.snippet ? `<div class="snippet">…${highlight(d.snippet.replace(/\s+/g, ' '), words)}…</div>` : ''}
        ${expiryBadge(d.expiry_date)}
      </div></button>`;
  }
  function thumbFallback(mime) {
    const ext = /pdf/.test(mime || '') ? 'PDF' : /image/.test(mime || '') ? 'IMG' : 'FILE';
    return `<span class="ext">${ext}</span>`;
  }
  async function signedUrls(paths) {
    const need = [...new Set(paths.filter(p => p && !S.urls.has(p)))];
    for (let i = 0; i < need.length; i += 100) {
      const { data } = await S.sb.storage.from(BUCKET).createSignedUrls(need.slice(i, i + 100), 3600);
      (data || []).forEach(r => { if (r.signedUrl) S.urls.set(r.path, r.signedUrl); });
    }
  }
  async function fillThumbs(docs) {
    await signedUrls(docs.map(d => d.thumb_path));
    $$('[data-thumb]').forEach(el => {
      const u = S.urls.get(el.dataset.thumb);
      if (u && !el.querySelector('img')) el.innerHTML = `<img src="${esc(u)}" alt="" loading="lazy">`;
    });
  }

  async function loadExpiring() {
    const { data } = await S.sb.from('fv_documents').select('id,title,expiry_date').not('expiry_date', 'is', null).order('expiry_date');
    const soon = (data || []).filter(d => daysUntil(d.expiry_date) <= SOON_DAYS);
    const box = $('#expBanner');
    if (!box || !soon.length) return;
    const expired = soon.filter(d => daysUntil(d.expiry_date) < 0).length;
    box.innerHTML = `<button class="banner" data-act="go" data-v="more">
      <b>${soon.length} document${soon.length === 1 ? '' : 's'} need${soon.length === 1 ? 's' : ''} attention</b>
      <span>${expired ? `${expired} expired · ` : ''}${soon.length - expired} expiring within ${SOON_DAYS} days</span></button>`;
  }

  // ---------- one document ----------
  async function openDoc(id) {
    const { data: d, error } = await S.sb.from('fv_documents').select('*').eq('id', id).maybeSingle();
    if (error || !d) return toast('Could not open this document.', true);
    await signedUrls([d.thumb_path]);
    const m = memberById(d.member_id);
    const uploader = S.users.find(u => u.user_id === d.uploaded_by) || (d.uploaded_by === S.user.id ? S.me : null);
    const canEdit = isAdmin() || (canUpload() && d.uploaded_by === S.user.id);
    const thumb = d.thumb_path && S.urls.get(d.thumb_path);
    openSheet(`
      <div class="sheet-head"><h2>${d.is_private ? ICON.lock : ''}${esc(d.title)}</h2><button class="icon-btn" data-act="closeSheet">${ICON.close}</button></div>
      <button class="preview" data-act="viewFile" data-id="${d.id}">${thumb ? `<img src="${esc(thumb)}" alt="">` : thumbFallback(d.mime_type)}<span>Tap to open</span></button>
      <div class="row gap wrap">
        <button class="btn primary" data-act="sendOne" data-id="${d.id}">Send</button>
        <button class="btn" data-act="viewFile" data-id="${d.id}">Open</button>
        <button class="btn" data-act="downloadFile" data-id="${d.id}">Download</button>
        ${canEdit ? `<button class="btn" data-act="editDoc" data-id="${d.id}">Edit</button>` : ''}
        ${isAdmin() ? `<button class="btn danger" data-act="deleteDoc" data-id="${d.id}">Delete</button>` : ''}
      </div>
      <dl class="facts">
        <dt>Belongs to</dt><dd>${esc(m ? m.name : '—')}</dd>
        <dt>Kind</dt><dd>${esc(d.doc_type || '—')}</dd>
        ${d.id_number ? `<dt>Number</dt><dd>${esc(d.id_number)}</dd>` : ''}
        ${d.expiry_date ? `<dt>Valid till</dt><dd>${fmtDate(d.expiry_date)} ${expiryBadge(d.expiry_date)}</dd>` : ''}
        <dt>Who can see it</dt><dd>${d.is_private ? `Private — only ${esc(m ? m.name : 'the person it belongs to')} and whoever uploaded it` : 'Everyone in the family'}</dd>
        <dt>Added</dt><dd>${fmtDate(d.created_at)}${uploader ? ' by ' + esc(uploader.display_name) : ''}</dd>
        <dt>File</dt><dd>${esc(d.file_name || '')} · ${fmtSize(d.size_bytes)}</dd>
      </dl>
      <div id="sentLog"></div>
      ${d.text_content ? `<details class="textbox"><summary>Text read from this document</summary><pre>${esc(d.text_content)}</pre></details>` : '<p class="muted">No text could be read from this file, so it is found only by its name.</p>'}
    `);
    loadSentLog(d.id);
  }
  async function loadSentLog(id) {
    const { data } = await S.sb.from('fv_shares').select('*').eq('doc_id', id).order('created_at');
    const box = $('#sentLog');
    if (!box || !data || !data.length) return;
    const how = { file: 'shared the file', whatsapp: 'sent a link on WhatsApp', email: 'sent a link by email' };
    box.innerHTML = `<details class="textbox"><summary>Sent ${data.length} time${data.length === 1 ? '' : 's'}</summary><ul class="sentlog">${data.reverse().slice(0, 20).map(s => {
      const who = S.users.find(u => u.user_id === s.sent_by) || (s.sent_by === S.user.id ? S.me : null);
      const live = s.link_expires && new Date(s.link_expires) > new Date();
      return `<li><b>${fmtDate(s.created_at)}</b> · ${esc(who ? who.display_name : 'Someone')} ${how[s.method] || 'sent it'}${s.to_text ? ' to ' + esc(s.to_text) : ''}${s.link_expires ? ` · link ${live ? 'works till' : 'expired'} ${fmtWhen(s.link_expires)}` : ''}</li>`;
    }).join('')}</ul></details>`;
  }
  const fmtWhen = iso => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

  // =====================================================================
  //  Sending documents — the file itself, or a download link to a number / email
  // =====================================================================
  const LINK_LIFE = [['3600', '1 hour'], ['86400', '1 day'], ['604800', '7 days']];
  const waNumber = v => { let d = String(v || '').replace(/\D/g, ''); if (d.length === 11 && d[0] === '0') d = d.slice(1); if (d.length === 10) d = '91' + d; return d; };
  const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());

  async function sendSheet(ids) {
    const { data: docs, error } = await S.sb.from('fv_documents').select('id,title,file_path,file_name,mime_type,size_bytes,is_private').in('id', ids);
    if (error || !docs || !docs.length) return toast('Could not load these documents.', true);
    const { data: contacts } = await S.sb.from('fv_contacts').select('*').order('name');
    const total = docs.reduce((a, d) => a + (d.size_bytes || 0), 0);
    const anyPrivate = docs.some(d => d.is_private);
    const many = docs.length > 1;
    S.sending = { docs, contacts: contacts || [], files: null };
    openSheet(`
      <div class="sheet-head"><h2>Send ${many ? docs.length + ' documents' : 'document'}</h2><button class="icon-btn" data-act="closeSheet">${ICON.close}</button></div>
      <ul class="send-list">${docs.map(d => `<li>${d.is_private ? ICON.lock : ''}${esc(d.title)} <span class="muted small">${fmtSize(d.size_bytes)}</span></li>`).join('')}</ul>
      ${anyPrivate ? `<p class="flag amber">${many ? 'Some of these are' : 'This is'} marked private. Make sure you mean to send ${many ? 'them' : 'it'}.</p>` : ''}

      <div class="card send-card">
        <h3>Send the file itself</h3>
        <p class="muted small">Opens your phone's share menu — choose WhatsApp, Gmail or any app, then the person. The ${many ? 'files go' : 'file goes'} as ${many ? 'attachments' : 'an attachment'} (${fmtSize(total)}).</p>
        <button class="btn primary big" id="shareBtn" data-act="shareFiles">Share ${many ? 'files' : 'file'}…</button>
      </div>

      <div class="card send-card">
        <h3>Send to a WhatsApp number or email</h3>
        <p class="muted small">Sends a private download link. The person taps it to get the ${many ? 'files' : 'file'} — the link stops working after the time you choose.</p>
        <form id="sendForm" class="form">
          ${S.sending.contacts.length ? `<label>Saved contacts<select name="contact"><option value="">— Type a new one below —</option>${S.sending.contacts.map(c => `<option value="${c.id}">${esc(c.name)}${c.phone ? ' · ' + esc(c.phone) : ''}${c.email ? ' · ' + esc(c.email) : ''}</option>`).join('')}</select></label>` : ''}
          <label>Name (optional)<input name="name" placeholder="e.g. Ramesh CA" autocomplete="off"></label>
          <label>WhatsApp number<input name="phone" inputmode="tel" placeholder="10-digit mobile number" autocomplete="off"></label>
          <label>Email id<input name="email" type="email" inputmode="email" placeholder="name@gmail.com" autocomplete="off"></label>
          <label>Link works for<select name="life">${LINK_LIFE.map(([v, l]) => `<option value="${v}" ${v === '86400' ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="check"><input type="checkbox" name="save" checked> <span>Save this contact for next time</span></label>
          <div class="row gap"><button class="btn primary" type="button" data-act="sendLink" data-how="whatsapp">Send on WhatsApp</button>
          <button class="btn" type="button" data-act="sendLink" data-how="email">Send by email</button></div>
        </form>
        ${S.sending.contacts.length ? `<button class="link small" data-act="manageContacts">Remove saved contacts…</button>` : ''}
      </div>`);
    const f = $('#sendForm');
    if (f.contact) f.contact.addEventListener('change', () => {
      const c = S.sending.contacts.find(x => x.id === f.contact.value);
      f.name.value = c ? c.name : ''; f.phone.value = c ? (c.phone || '') : ''; f.email.value = c ? (c.email || '') : '';
      f.save.checked = !c;
    });
  }

  // Step 1 fetches the files; the phone only allows the share menu straight after a tap,
  // so if fetching took too long the button asks for one more tap.
  async function shareFiles(btn) {
    const SND = S.sending; if (!SND) return;
    try {
      if (!SND.files) {
        btn.disabled = true; btn.textContent = 'Getting files ready…';
        const urls = await Promise.all(SND.docs.map(d => S.sb.storage.from(BUCKET).createSignedUrl(d.file_path, 300).then(r => r.data && r.data.signedUrl)));
        SND.files = [];
        for (let i = 0; i < SND.docs.length; i++) {
          const d = SND.docs[i];
          const blob = await (await fetch(urls[i])).blob();
          const ext = (d.file_path.split('.').pop() || '').toLowerCase();
          const name = d.title.replace(/[\\/:*?"<>|]/g, '').trim() + (ext ? '.' + ext : '');
          SND.files.push(new File([blob], name, { type: d.mime_type || blob.type || 'application/octet-stream' }));
        }
        btn.disabled = false;
      }
      const payload = { files: SND.files, title: SND.docs.map(d => d.title).join(', ') };
      if (!navigator.canShare || !navigator.canShare({ files: SND.files })) {
        SND.files.forEach(f => { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); });
        btn.textContent = 'Downloaded — attach from Downloads';
        return toast('This browser cannot share files directly, so they were downloaded instead.');
      }
      try {
        await navigator.share(payload);
        await logShares('file', null, null);
        btn.textContent = 'Shared ✓';
      } catch (e) {
        if (e.name === 'AbortError') { btn.textContent = 'Share file…'; return; }
        if (e.name === 'NotAllowedError') { btn.textContent = 'Ready — tap to share'; return; }
        throw e;
      }
    } catch (e) { btn.disabled = false; btn.textContent = 'Try again'; toast(niceError(e), true); }
  }

  async function sendLink(how) {
    const SND = S.sending; if (!SND) return;
    const f = $('#sendForm');
    const name = f.name.value.trim(), phone = f.phone.value.trim(), email = f.email.value.trim();
    if (how === 'whatsapp' && waNumber(phone).length < 11) return toast('Type a valid WhatsApp number.', true);
    if (how === 'email' && !validEmail(email)) return toast('Type a valid email id.', true);
    const life = +f.life.value;
    // WhatsApp opens in a new tab; open it now, while the tap still counts, and fill it in below
    const w = how === 'whatsapp' ? window.open('about:blank', '_blank') : null;
    try {
      const links = [];
      for (const d of SND.docs) {
        const ext = (d.file_path.split('.').pop() || '').toLowerCase();
        const { data, error } = await S.sb.storage.from(BUCKET).createSignedUrl(d.file_path, life, { download: d.title.replace(/[\\/:*?"<>|]/g, '').trim() + (ext ? '.' + ext : '') });
        if (error) throw error;
        links.push({ title: d.title, url: data.signedUrl });
      }
      const till = new Date(Date.now() + life * 1000);
      const greet = name ? `Hi ${name.split(' ')[0]},\n\n` : '';
      const body = `${greet}${links.map(l => `${l.title}\n${l.url}`).join('\n\n')}\n\n(Link${links.length > 1 ? 's' : ''} work till ${fmtWhen(till.toISOString())}.)\n— ${S.me.display_name}`;
      const subject = links.length === 1 ? links[0].title : `${links.length} documents`;
      if (how === 'whatsapp') {
        const url = `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(body)}`;
        if (w) w.location.href = url; else location.href = url;
      } else {
        location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      }
      const to = [name, how === 'whatsapp' ? '+' + waNumber(phone) : email].filter(Boolean).join(' · ');
      await logShares(how, to, till.toISOString());
      if (f.save.checked && (phone || email)) {
        const dupe = SND.contacts.some(c => (phone && waNumber(c.phone) === waNumber(phone)) || (email && c.email && c.email.toLowerCase() === email.toLowerCase()));
        if (!dupe) {
          const { data } = await S.sb.from('fv_contacts').insert({ name: name || phone || email, phone: phone || null, email: email || null, created_by: S.user.id }).select().single();
          if (data) SND.contacts.push(data);
        }
      }
      toast(how === 'whatsapp' ? 'Opening WhatsApp…' : 'Opening your email app…');
    } catch (e) { if (w) w.close(); toast(niceError(e), true); }
  }
  async function logShares(method, to, expires) {
    const rows = S.sending.docs.map(d => ({ doc_id: d.id, method, to_text: to, link_expires: expires, sent_by: S.user.id }));
    await S.sb.from('fv_shares').insert(rows);
  }
  async function manageContacts() {
    const list = S.sending.contacts;
    openSheet(`<div class="sheet-head"><h2>Saved contacts</h2><button class="icon-btn" data-act="closeSheet">${ICON.close}</button></div>
      <div class="card list-tight">${list.map(c => `<div class="exp-row"><span>${esc(c.name)}<br><span class="muted small">${esc([c.phone, c.email].filter(Boolean).join(' · '))}</span></span>
        ${isAdmin() || c.created_by === S.user.id ? `<button class="btn small danger" data-act="deleteContact" data-id="${c.id}">Remove</button>` : ''}</div>`).join('') || '<p class="muted">None saved.</p>'}</div>
      <button class="btn big" data-act="backToSend">Back</button>`);
  }
  async function fileUrl(id, download) {
    const { data: d } = await S.sb.from('fv_documents').select('file_path,file_name,title,mime_type').eq('id', id).maybeSingle();
    if (!d) throw new Error('Document not found');
    const ext = (d.file_name || '').split('.').pop();
    const opts = download ? { download: d.title.replace(/[\\/:*?"<>|]/g, '') + (ext ? '.' + ext : '') } : undefined;
    const { data, error } = await S.sb.storage.from(BUCKET).createSignedUrl(d.file_path, 300, opts);
    if (error) throw error;
    return data.signedUrl;
  }
  async function viewFile(id, download) {
    const w = download ? null : window.open('about:blank', '_blank');   // opened straight away so the phone doesn't block it
    try {
      const url = await fileUrl(id, download);
      if (w) w.location.href = url; else location.href = url;
    } catch (e) { if (w) w.close(); toast(niceError(e), true); }
  }

  async function editDoc(id) {
    const { data: d } = await S.sb.from('fv_documents').select('*').eq('id', id).maybeSingle();
    if (!d) return;
    openSheet(`
      <div class="sheet-head"><h2>Edit document</h2><button class="icon-btn" data-act="closeSheet">${ICON.close}</button></div>
      <form id="editForm" class="form">
        <label>Name<div class="row small-gap"><input name="title" value="${esc(d.title)}" required><button type="button" class="btn" id="resuggest">Suggest</button></div></label>
        <label>Belongs to<select name="member_id"><option value="">— Nobody in particular —</option>${S.members.map(m => `<option value="${m.id}" ${m.id === d.member_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
        <label>Kind of document<select name="doc_type"><option value="">—</option>${typeOptions(d.doc_type || '', d.doc_type)}</select></label>
        <label>Number on the document<input name="id_number" value="${esc(d.id_number || '')}"></label>
        <label>Valid till (optional)<input type="date" name="expiry_date" value="${esc(d.expiry_date || '')}"></label>
        <label class="check"><input type="checkbox" name="is_private" ${d.is_private ? 'checked' : ''}> <span><b>Private</b> — only the person it belongs to (and whoever uploaded it) can see it</span></label>
        <button class="btn primary big">Save changes</button>
      </form>`);
    $('#resuggest').onclick = () => {
      const f = $('#editForm');
      const m = memberById(f.member_id.value);
      const r = D.analyse(d.text_content || '', d.file_name, m ? [m] : S.members);
      const base = r.docType ? r.title.replace(new RegExp('^' + (r.member ? r.member.name : r.guessedName.split(' ')[0] || '') + '\\s*', 'i'), '') : '';
      const type = f.doc_type.value || r.docType;
      f.title.value = [m ? m.name : (r.member ? r.member.name : ''), base || type || 'Document'].filter(Boolean).join(' ');
    };
    $('#editForm').onsubmit = async e => {
      e.preventDefault();
      const f = e.target;
      const row = {
        title: f.title.value.trim(), member_id: f.member_id.value || null, doc_type: f.doc_type.value || null,
        id_number: f.id_number.value.trim() || null, expiry_date: f.expiry_date.value || null, is_private: f.is_private.checked
      };
      if (row.is_private && !row.member_id) return toast('Pick who this private document belongs to.', true);
      const { error } = await S.sb.from('fv_documents').update(row).eq('id', id);
      if (error) return toast(niceError(error), true);
      closeSheet(); toast('Saved'); if (S.view === 'docs') runSearch(); else renderShell();
    };
  }
  async function deleteDoc(id) {
    const { data: d } = await S.sb.from('fv_documents').select('title,file_path,thumb_path').eq('id', id).maybeSingle();
    if (!d || !confirm(`Delete “${d.title}” for everyone? This cannot be undone.`)) return;
    const { error: e1 } = await S.sb.storage.from(BUCKET).remove([d.file_path, d.thumb_path].filter(Boolean));
    if (e1) return toast(niceError(e1), true);
    const { error } = await S.sb.from('fv_documents').delete().eq('id', id);
    if (error) return toast(niceError(error), true);
    closeSheet(); toast('Deleted'); runSearch();
  }

  // =====================================================================
  //  Adding documents (one, many, or a whole pen-drive folder)
  // =====================================================================
  const SKIP_NAME = /^(\.|~\$)|^(thumbs\.db|desktop\.ini|\.ds_store)$/i;
  const SKIP_EXT = /\.(exe|dll|lnk|sys|tmp|ini|bat|cmd|msi|apk|db|log|url|inf)$/i;
  const READABLE_IMG = /^image\/(jpeg|png|webp|gif|bmp)$/;
  const isPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

  function viewAdd() {
    if (S.batch && S.batch.phase !== 'done') return renderBatch();
    const desktop = !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    main().innerHTML = `
      <h2 class="h">Add documents</h2>
      <div class="add-grid">
        <label class="add-btn">${ICON.camera}<b>Take a photo</b><span>Use the phone camera</span>
          <input type="file" accept="image/*" capture="environment" hidden data-pick></label>
        <label class="add-btn">${ICON.file}<b>Choose files</b><span>PDFs or photos — pick many at once</span>
          <input type="file" multiple accept="application/pdf,image/*,.doc,.docx,.xls,.xlsx" hidden data-pick></label>
        <label class="add-btn ${desktop ? '' : 'dim'}">${ICON.folder}<b>Import a whole folder</b><span>${desktop ? 'For the pen drive — every file inside is checked' : 'Works on a computer (Chrome)'}</span>
          <input type="file" webkitdirectory multiple hidden data-pick></label>
      </div>
      <div class="card note">
        <b>What happens next</b>
        <p>Each file is read on this device. The app suggests a name like “Diansh Birth Certificate”, finds whose document it is, and checks it against everything already saved so copies are caught. Nothing is saved until you check and tap <b>Save</b>.</p>
      </div>`;
    $$('[data-pick]').forEach(inp => inp.addEventListener('change', e => { const files = [...e.target.files]; e.target.value = ''; if (files.length) startBatch(files); }));
  }

  async function sha256(buf) {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function startBatch(files) {
    let ignored = 0;
    const items = [];
    for (const f of files) {
      if (SKIP_NAME.test(f.name) || SKIP_EXT.test(f.name) || f.size === 0) { ignored++; continue; }
      items.push({
        uid: uid(), file: f, name: f.name, path: f.webkitRelativePath || f.name, size: f.size, status: 'waiting',
        include: false, title: '', memberSel: '', docType: '', isPrivate: false, expiry: '', idNumber: '', text: '',
        dup: null, note: '', titleTouched: false
      });
    }
    if (!items.length) return toast(ignored ? 'No documents in that selection (only system files).' : 'Nothing selected.', true);
    S.batch = { items, ignored, phase: 'reading', stop: false, done: 0, startedAt: Date.now() };
    S.view = 'add'; renderShell();
    processBatch();
  }

  async function processBatch() {
    const B = S.batch;
    const bySha = new Map();
    for (const it of B.items) {
      if (B.stop || S.batch !== B) break;
      it.status = 'reading'; updateProgress(it);
      try { await readItem(it, B, bySha); }
      catch (e) { it.status = 'ready'; it.note = 'Could not read this file: ' + niceError(e); it.title = it.title || D.cleanFileName(it.name) || ''; it.include = !!it.title; }
      B.done++;
      updateProgress();
    }
    if (S.batch !== B) return;
    B.items.forEach(it => { if (it.status === 'waiting' || it.status === 'reading') { it.status = 'ready'; it.note = 'Not read (stopped early)'; it.include = false; it.title = D.cleanFileName(it.name); } });
    B.phase = 'review';
    if (ocrWorker) { try { await ocrWorker.terminate(); } catch { /* ignore */ } ocrWorker = null; }
    if (S.view === 'add') renderShell();
  }

  async function readItem(it, B, bySha) {
    if (it.size > MAX_FILE) { it.status = 'ready'; it.note = 'Too big — the storage plan allows 50 MB per file.'; it.include = false; it.title = D.cleanFileName(it.name); it.tooBig = true; return; }
    const buf = await it.file.arrayBuffer();
    it.sha = await sha256(buf);

    // 1. exact copy inside this same selection?
    if (bySha.has(it.sha)) {
      const first = bySha.get(it.sha);
      Object.assign(it, { status: 'ready', include: false, title: first.title, memberSel: first.memberSel, docType: first.docType, thumbUrl: first.thumbUrl, thumbBlob: first.thumbBlob, text: first.text, idNumber: first.idNumber, expiry: first.expiry });
      it.dup = { kind: 'copy', of: first.uid, text: `Exact copy of “${first.name}” in this selection` };
      return;
    }
    bySha.set(it.sha, it);

    // 2. exact copy already saved?
    const { data: cnt } = await S.sb.rpc('fv_hash_count', { p_sha: it.sha });
    if (cnt > 0) {
      const { data: seen } = await S.sb.from('fv_documents').select('id,title').eq('sha256', it.sha);
      const names = (seen || []).map(s => `“${s.title}”`);
      const hidden = cnt - names.length;
      it.dup = { kind: 'saved', ids: (seen || []).map(s => s.id), text: 'Already saved as ' + (names.join(', ') || '') + (hidden > 0 ? (names.length ? ' and ' : '') + `${hidden} private document${hidden > 1 ? 's' : ''}` : '') };
    }

    // 3. read the text and make a small picture
    const ex = await extract(it.file, buf, !it.dup);
    it.text = ex.text; it.thumbBlob = ex.thumb; it.thumbUrl = ex.thumb ? URL.createObjectURL(ex.thumb) : '';
    if (ex.note) it.note = ex.note;

    // 4. suggestion
    const r = D.analyse(it.text, it.name, S.members);
    it.analysis = r;
    it.docType = r.docType || (ex.isPhoto ? 'Photo' : '');
    it.idNumber = r.idNumber; it.expiry = r.expiry;
    it.memberSel = r.member ? r.member.id : (r.guessedName ? 'new:' + r.guessedName : '');
    it.base = baseTitle(r);
    it.title = r.title || (ex.isPhoto ? 'Photo ' + fmtDate(new Date(it.file.lastModified).toISOString()) : '') || `Document ${B.items.indexOf(it) + 1}`;
    it.unread = !r.readable && !r.docType && !D.cleanFileName(it.name);

    // 5. same document scanned twice?
    if (!it.dup) {
      for (const o of B.items) {
        if (o === it || o.status !== 'ready' || o.dup) continue;
        const sameNo = it.idNumber && o.idNumber === it.idNumber && o.docType === it.docType;
        const sim = it.docType && o.docType === it.docType ? D.similarity(it.text, o.text) : 0;
        if (sameNo || sim >= 0.75) {
          it.dup = { kind: 'similar', of: o.uid, text: sameNo ? `Same ${it.docType} number as “${o.title}” in this selection${sim < 0.5 ? ' — maybe the other side of the card?' : ''}` : `Looks like the same document as “${o.title}” in this selection` };
          break;
        }
      }
    }
    if (!it.dup && (it.idNumber || lettersIn(it.text) >= 60)) {
      const { data: sim } = await S.sb.rpc('fv_find_similar', { p_text: (it.text || '').slice(0, 3000), p_id_number: it.idNumber || null, p_doc_type: it.docType || null });
      if (sim && sim.length) {
        const s = sim[0];
        it.dup = { kind: 'similar-saved', ids: sim.map(x => x.id), text: s.reason === 'same number'
          ? `Already saved: “${s.title}” has the same number. If this is the other side of the card, tick it to save it too.`
          : `Looks like “${s.title}”, which is already saved` };
      }
    }
    it.include = !it.dup && !it.unread;
    it.status = 'ready';
  }
  function baseTitle(r) {
    if (!r.title) return '';
    const p = r.member ? r.member.name : (r.guessedName ? r.guessedName.split(' ')[0] : '');
    return p && r.title.toLowerCase().startsWith(p.toLowerCase() + ' ') ? r.title.slice(p.length + 1) : r.title;
  }

  // read text from a PDF or a photo; returns { text, thumb, note, isPhoto }
  async function extract(file, buf, doOcr) {
    if (isPdf(file)) return extractPdf(buf, doOcr);
    if (READABLE_IMG.test(file.type) || /\.(jpe?g|png|webp|bmp|gif)$/i.test(file.name)) return extractImage(file, doOcr);
    return { text: '', thumb: null, note: 'This kind of file cannot be read inside — check the name yourself.' };
  }
  async function extractPdf(buf, doOcr) {
    const lib = await pdfjs();
    let pdf;
    try { pdf = await lib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise; }
    catch (e) { return { text: '', thumb: null, note: /password/i.test(e.name + e.message) ? 'This PDF is password-locked, so it could not be read.' : 'This PDF looks damaged.' }; }
    let text = '';
    const pages = Math.min(pdf.numPages, 6);
    for (let p = 1; p <= pages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      let lastY = null, line = '';
      for (const item of tc.items) {
        const y = item.transform ? Math.round(item.transform[5]) : lastY;
        if (lastY !== null && Math.abs(y - lastY) > 3) { text += line.trim() + '\n'; line = ''; }
        line += item.str + ' ';
        lastY = y;
      }
      text += line.trim() + '\n\n';
    }
    const thumb = await canvasToBlob(await renderPdfPage(pdf, 1, 360), 0.7);
    if (doOcr && lettersIn(text) < 40) {             // a scanned PDF: the text is only a picture, so read the picture
      let o = '';
      for (let p = 1; p <= Math.min(pdf.numPages, 3); p++) o += (await ocr(await renderPdfPage(pdf, p, 1800))) + '\n\n';
      text = o;
    }
    try { pdf.destroy(); } catch { /* ignore */ }
    return { text: text.trim(), thumb };
  }
  async function renderPdfPage(pdf, n, width) {
    const page = await pdf.getPage(n);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: width / v1.width });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return c;
  }
  async function loadBitmap(file) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch {
      return await new Promise((res, rej) => {
        const img = new Image(); const u = URL.createObjectURL(file);
        img.onload = () => { res(img); URL.revokeObjectURL(u); }; img.onerror = () => rej(new Error('This picture could not be opened.')); img.src = u;
      });
    }
  }
  function drawScaled(bmp, max, rotate = 0) {
    const w = bmp.width, h = bmp.height, k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    const sw = Math.round(w * k), sh = Math.round(h * k);
    if (rotate % 180) { c.width = sh; c.height = sw; } else { c.width = sw; c.height = sh; }
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.translate(c.width / 2, c.height / 2); ctx.rotate(rotate * Math.PI / 180);
    ctx.drawImage(bmp, -sw / 2, -sh / 2, sw, sh);
    return c;
  }
  const canvasToBlob = (c, q) => new Promise(r => c.toBlob(b => r(b), 'image/jpeg', q));
  const realWords = t => (String(t).match(/[A-Za-z]{3,}/g) || []).length;
  async function extractImage(file, doOcr) {
    const bmp = await loadBitmap(file);
    const thumb = await canvasToBlob(drawScaled(bmp, 360), 0.7);
    if (!doOcr) return { text: '', thumb };
    let text = await ocr(drawScaled(bmp, 2000));
    if (realWords(text) < 8) {                       // maybe the photo is sideways — try turning it
      for (const r of [90, 270]) {
        const t2 = await ocr(drawScaled(bmp, 2000, r));
        if (realWords(t2) > realWords(text) + 4) text = t2;
        if (realWords(text) >= 8) break;
      }
    }
    const isPhoto = realWords(text) < 4;
    return { text: isPhoto ? '' : text.trim(), thumb, isPhoto };
  }

  // ---------- progress while reading ----------
  function updateProgress(current) {
    const B = S.batch;
    if (!B || S.view !== 'add' || B.phase !== 'reading') return;
    const bar = $('#prog');
    if (!bar) return renderBatch();
    const n = B.items.length;
    const per = B.done ? (Date.now() - B.startedAt) / B.done : 0;
    const left = per ? Math.ceil(per * (n - B.done) / 60000) : null;
    bar.style.width = (100 * B.done / n) + '%';
    $('#progText').textContent = `Read ${B.done} of ${n}` + (left != null && B.done < n ? ` · about ${left} min left` : '');
    if (current) $('#progFile').textContent = current.path;
  }

  // ---------- review screen ----------
  function renderBatch() {
    const B = S.batch;
    if (B.phase === 'reading') {
      main().innerHTML = `
        <h2 class="h">Reading your files</h2>
        <div class="card">
          <div class="progress"><div id="prog" style="width:${100 * B.done / B.items.length}%"></div></div>
          <p id="progText" class="muted">Read ${B.done} of ${B.items.length}</p>
          <p id="progFile" class="muted small ellipsis"></p>
          <p class="hint">Scanned pages and photos take a few seconds each. Keep this screen open${B.items.length > 20 ? ' — a pen drive full of files can take a while' : ''}.</p>
          <button class="btn" data-act="stopBatch">Stop and check what's read so far</button>
        </div>`;
      return;
    }
    const saved = B.items.filter(i => i.status === 'saved').length;
    const groups = [
      ['Duplicates', 'Not saved unless you tick them.', B.items.filter(i => i.dup && i.status !== 'saved')],
      ['Ready to save', 'Check the names — tap any to change.', B.items.filter(i => !i.dup && !i.unread && !i.note && i.status !== 'saved')],
      ['Check these', "These couldn't be read properly. Name them yourself or leave them unticked.", B.items.filter(i => !i.dup && (i.unread || i.note) && i.status !== 'saved')],
      ['Saved', '', B.items.filter(i => i.status === 'saved')]
    ];
    const sel = B.items.filter(i => i.include && i.status !== 'saved').length;
    main().innerHTML = `
      <div class="row between"><h2 class="h">Check before saving</h2><button class="btn small" data-act="cancelBatch">${B.phase === 'done' ? 'Finish' : 'Cancel'}</button></div>
      <p class="muted">${B.items.length} file${B.items.length === 1 ? '' : 's'} read${B.ignored ? ` · ${B.ignored} system file${B.ignored === 1 ? '' : 's'} ignored` : ''}${saved ? ` · ${saved} saved` : ''}</p>
      ${groups.map(([h, sub, list]) => list.length ? `
        <section class="group"><div class="group-head"><h3>${h} <span class="count">${list.length}</span></h3>
          ${h !== 'Saved' ? `<span class="row small-gap"><button class="link" data-act="tickAll" data-g="${h}" data-on="1">Tick all</button><button class="link" data-act="tickAll" data-g="${h}" data-on="0">Untick all</button></span>` : ''}</div>
          ${sub ? `<p class="muted small">${sub}</p>` : ''}
          ${list.map(itemCard).join('')}</section>` : '').join('')}
      <div class="savebar">${B.phase === 'saving'
        ? `<div class="progress"><div id="saveProg" style="width:0"></div></div><span id="saveText">Saving…</span>`
        : sel ? `<button class="btn primary big" data-act="saveBatch">Save ${sel} document${sel === 1 ? '' : 's'}</button>`
          : `<button class="btn big" data-act="cancelBatch">${saved ? 'Done' : 'Nothing ticked — close'}</button>`}</div>`;
    loadDupThumbs();
  }
  function memberOptions(it) {
    const guess = it.analysis && it.analysis.guessedName;
    return `<option value="">— Nobody in particular —</option>
      ${S.members.map(m => `<option value="${m.id}" ${it.memberSel === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
      ${guess && !S.members.some(m => (m.full_name || m.name).toLowerCase() === guess.toLowerCase()) ? `<option value="new:${esc(guess)}" ${it.memberSel === 'new:' + guess ? 'selected' : ''}>+ New person: ${esc(guess)}</option>` : ''}
      ${it.memberSel && it.memberSel.startsWith('new:') && it.memberSel !== 'new:' + guess ? `<option value="${esc(it.memberSel)}" selected>+ New person: ${esc(it.memberSel.slice(4))}</option>` : ''}
      <option value="ask">+ Someone else…</option>`;
  }
  function itemCard(it) {
    const done = it.status === 'saved';
    return `<div class="item ${it.include ? 'on' : ''} ${done ? 'saved' : ''}" data-uid="${it.uid}">
      <label class="tick">${done ? '✓' : `<input type="checkbox" data-f="include" ${it.include ? 'checked' : ''} ${it.tooBig ? 'disabled' : ''}>`}</label>
      <button class="thumb" data-act="previewItem" data-uid="${it.uid}">${it.thumbUrl ? `<img src="${it.thumbUrl}" alt="">` : thumbFallback(it.file.type || (isPdf(it.file) ? 'pdf' : ''))}</button>
      <div class="item-body">
        ${done ? `<div class="doc-title">${esc(it.title)}</div>` : `
        <input class="title-in" data-f="title" value="${esc(it.title)}" placeholder="Name this document">
        <div class="row small-gap wrap">
          <select data-f="memberSel" class="select-sm">${memberOptions(it)}</select>
          <select data-f="docType" class="select-sm"><option value="">Kind…</option>${typeOptions(it.docType, it.docType)}</select>
          <label class="mini-check"><input type="checkbox" data-f="isPrivate" ${it.isPrivate ? 'checked' : ''}> ${ICON.lock}Private</label>
        </div>
        ${it.expiry || (it.analysis && /Passport|Licence|Insurance|PUC|RC|Agreement|Warranty/.test(it.docType)) ? `<label class="mini">Valid till <input type="date" data-f="expiry" value="${esc(it.expiry || '')}"></label>` : ''}`}
        <div class="file-line ellipsis">${esc(it.path)} · ${fmtSize(it.size)}</div>
        ${it.dup ? `<div class="flag amber">${esc(it.dup.text)}</div>${it.dup.ids ? `<div class="dup-thumbs" data-dup="${it.dup.ids.join(',')}"></div>` : ''}` : ''}
        ${it.note ? `<div class="flag">${esc(it.note)}</div>` : ''}
        ${it.error ? `<div class="flag red">${esc(it.error)}</div>` : ''}
      </div></div>`;
  }
  async function loadDupThumbs() {
    const boxes = $$('[data-dup]');
    if (!boxes.length) return;
    const ids = [...new Set(boxes.flatMap(b => b.dataset.dup.split(',')))];
    const { data } = await S.sb.from('fv_documents').select('id,title,thumb_path').in('id', ids);
    await signedUrls((data || []).map(d => d.thumb_path));
    boxes.forEach(b => {
      b.innerHTML = b.dataset.dup.split(',').map(id => (data || []).find(d => d.id === id)).filter(Boolean)
        .map(d => `<button class="dup-chip" data-act="openDoc" data-id="${d.id}">${S.urls.get(d.thumb_path) ? `<img src="${esc(S.urls.get(d.thumb_path))}" alt="">` : ''}<span>Saved: ${esc(d.title)}</span></button>`).join('');
    });
  }
  function itemFromEl(el) { const box = el.closest('[data-uid]'); return box && S.batch && S.batch.items.find(i => i.uid === box.dataset.uid); }
  function personName(sel) {
    if (!sel) return '';
    if (sel.startsWith('new:')) return sel.slice(4).split(' ')[0];
    const m = memberById(sel); return m ? m.name : '';
  }
  function onItemChange(el) {
    const it = itemFromEl(el); if (!it) return;
    const f = el.dataset.f;
    if (f === 'include' || f === 'isPrivate') it[f] = el.checked;
    else if (f === 'memberSel') {
      let v = el.value;
      if (v === 'ask') {
        const n = (prompt('Full name of this person, as written on their documents:') || '').trim();
        v = n ? 'new:' + D.titleCase(n) : it.memberSel;
      }
      it.memberSel = v;
      if (!it.titleTouched) {
        const p = personName(v);
        const base = it.base || it.docType || it.title;
        it.title = [p, base].filter(Boolean).join(' ');
      }
      renderBatch(); return;
    } else if (f === 'docType') {
      it.docType = el.value;
      if (!it.titleTouched) { it.base = el.value; it.title = [personName(it.memberSel), el.value].filter(Boolean).join(' '); renderBatch(); return; }
    } else if (f === 'title') { it.title = el.value; it.titleTouched = true; }
    else it[f] = el.value;
    if (f === 'include') { el.closest('.item').classList.toggle('on', el.checked); refreshSaveBar(); }
  }
  function refreshSaveBar() {
    const B = S.batch; if (!B || B.phase === 'saving') return;
    const sel = B.items.filter(i => i.include && i.status !== 'saved').length;
    const bar = $('.savebar');
    if (bar) bar.innerHTML = sel ? `<button class="btn primary big" data-act="saveBatch">Save ${sel} document${sel === 1 ? '' : 's'}</button>` : `<button class="btn big" data-act="cancelBatch">Nothing ticked — close</button>`;
  }

  async function shrinkIfLarge(file) {
    if (!pref('shrink', true) || !/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1.5 * 1048576) return { blob: file, type: file.type, ext: (file.name.split('.').pop() || 'jpg').toLowerCase() };
    const bmp = await loadBitmap(file);
    const blob = await canvasToBlob(drawScaled(bmp, 2400), 0.85);
    return blob && blob.size < file.size ? { blob, type: 'image/jpeg', ext: 'jpg' } : { blob: file, type: file.type, ext: (file.name.split('.').pop() || 'jpg').toLowerCase() };
  }

  async function saveBatch() {
    const B = S.batch;
    const todo = B.items.filter(i => i.include && i.status !== 'saved');
    for (const it of todo) {
      if (!it.title.trim()) return toast(`Give a name to “${it.name}” first.`, true);
      if (it.isPrivate && !it.memberSel) return toast(`“${it.title}” is private — pick who it belongs to.`, true);
    }
    B.phase = 'saving'; renderBatch();
    const newPeople = new Map();
    let n = 0, failed = 0;
    for (const it of todo) {
      try {
        let memberId = it.memberSel || null;
        if (memberId && memberId.startsWith('new:')) {
          const full = memberId.slice(4);
          if (!newPeople.has(full)) {
            const { data, error } = await S.sb.from('fv_members').insert({ name: full.split(' ')[0], full_name: full }).select().single();
            if (error) throw error;
            newPeople.set(full, data.id); S.members.push(data);
          }
          memberId = newPeople.get(full);
          B.items.forEach(o => { if (o.memberSel === it.memberSel) o.memberSel = memberId; });
        }
        const id = uid();
        const up = await shrinkIfLarge(it.file);
        const ext = (/^[a-z0-9]{1,5}$/.test(up.ext) ? up.ext : 'bin');
        const filePath = `files/${id}.${ext}`;
        const thumbPath = it.thumbBlob ? `thumbs/${id}.jpg` : null;
        const { error: e1 } = await S.sb.storage.from(BUCKET).upload(filePath, up.blob, { contentType: up.type || 'application/octet-stream', upsert: false });
        if (e1) throw e1;
        if (thumbPath) await S.sb.storage.from(BUCKET).upload(thumbPath, it.thumbBlob, { contentType: 'image/jpeg', upsert: false });
        const { error: e2 } = await S.sb.from('fv_documents').insert({
          id, title: it.title.trim(), doc_type: it.docType || null, member_id: memberId, is_private: !!it.isPrivate,
          file_path: filePath, thumb_path: thumbPath, file_name: it.name, mime_type: up.type || it.file.type || null,
          size_bytes: up.blob.size, sha256: it.sha, text_content: it.text || null, id_number: it.idNumber || null,
          expiry_date: it.expiry || null, uploaded_by: S.user.id
        });
        if (e2) { await S.sb.storage.from(BUCKET).remove([filePath, thumbPath].filter(Boolean)); throw e2; }
        it.status = 'saved'; it.error = '';
      } catch (e) { it.error = 'Not saved: ' + niceError(e); failed++; }
      n++;
      const bar = $('#saveProg'); if (bar) bar.style.width = (100 * n / todo.length) + '%';
      const t = $('#saveText'); if (t) t.textContent = `Saving ${n} of ${todo.length}…`;
    }
    B.phase = B.items.some(i => i.status !== 'saved' && i.include) ? 'review' : 'done';
    toast(failed ? `${n - failed} saved, ${failed} failed — see the red notes.` : `${n} document${n === 1 ? '' : 's'} saved`, !!failed);
    if (B.phase === 'done') { finishBatch(); S.view = 'docs'; S.q = ''; S.filterMember = ''; S.filterType = ''; }
    renderShell();
  }
  function finishBatch() {
    if (S.batch) S.batch.items.forEach(i => i.thumbUrl && URL.revokeObjectURL(i.thumbUrl));
    S.batch = null;
  }

  // =====================================================================
  //  Family members
  // =====================================================================
  async function viewFamily() {
    const { data } = await S.sb.from('fv_documents').select('member_id');
    const counts = {};
    (data || []).forEach(d => { counts[d.member_id || ''] = (counts[d.member_id || ''] || 0) + 1; });
    main().innerHTML = `
      <div class="row between"><h2 class="h">Family</h2>${canUpload() ? '<button class="btn primary small" data-act="editMember" data-id="">+ Add person</button>' : ''}</div>
      <p class="muted">Documents are matched to people by the names below. Add other spellings if a document writes a name differently.</p>
      <div class="list">${S.members.map(m => `
        <div class="person card">
          <button class="person-main" data-act="showMemberDocs" data-id="${m.id}">
            <span class="avatar">${esc(m.name.slice(0, 1).toUpperCase())}</span>
            <span><b>${esc(m.name)}</b>${m.relation ? ` <span class="muted">· ${esc(m.relation)}</span>` : ''}<br>
            <span class="muted small">${esc(m.full_name || '')}${m.aliases ? ' · also ' + esc(m.aliases) : ''}</span></span>
            <span class="count">${counts[m.id] || 0}</span></button>
          ${isAdmin() ? `<button class="link" data-act="editMember" data-id="${m.id}">Edit</button>` : ''}
        </div>`).join('') || '<div class="empty">No family members yet. Add everyone whose documents you will keep.</div>'}
        ${counts[''] ? `<div class="muted small pad">${counts['']} document${counts[''] > 1 ? 's' : ''} not linked to anyone.</div>` : ''}
      </div>`;
  }
  function editMember(id) {
    const m = memberById(id) || {};
    openSheet(`
      <div class="sheet-head"><h2>${id ? 'Edit person' : 'Add a family member'}</h2><button class="icon-btn" data-act="closeSheet">${ICON.close}</button></div>
      <form id="memberForm" class="form">
        <label>Short name (used in document names)<input name="name" required value="${esc(m.name || '')}" placeholder="Diansh"></label>
        <label>Full name, as on documents<input name="full_name" value="${esc(m.full_name || '')}" placeholder="Diansh Agarwal"></label>
        <label>Other spellings (optional, separate with commas)<input name="aliases" value="${esc(m.aliases || '')}" placeholder="Dians, Diyansh"></label>
        <label>Relation (optional)<input name="relation" value="${esc(m.relation || '')}" placeholder="Son"></label>
        <button class="btn primary big">Save</button>
        ${id ? '<button type="button" class="btn danger" data-act="deleteMember" data-id="' + id + '">Remove this person</button>' : ''}
      </form>`);
    $('#memberForm').onsubmit = async e => {
      e.preventDefault();
      const f = e.target;
      const row = { name: D.titleCase(f.name.value), full_name: D.titleCase(f.full_name.value) || null, aliases: f.aliases.value.trim() || null, relation: f.relation.value.trim() || null };
      const { error } = id ? await S.sb.from('fv_members').update(row).eq('id', id) : await S.sb.from('fv_members').insert(row);
      if (error) return toast(niceError(error), true);
      await loadMembers(); closeSheet(); toast('Saved'); renderShell();
    };
  }
  async function deleteMember(id) {
    const m = memberById(id);
    if (!m || !confirm(`Remove ${m.name}? Their documents stay saved but will not be linked to anyone.`)) return;
    const { error } = await S.sb.from('fv_members').delete().eq('id', id);
    if (error) return toast(niceError(error), true);
    await loadMembers(); closeSheet(); renderShell();
  }

  // =====================================================================
  //  Passwords — locked with a master password that never leaves the phone
  // =====================================================================
  const te = new TextEncoder(), td = new TextDecoder();
  const b64 = u8 => btoa(String.fromCharCode(...new Uint8Array(u8)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function deriveKey(pw, salt) {
    const base = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encrypt(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj)));
    return { iv: b64(iv), data: b64(ct) };
  }
  async function decrypt(key, iv, data) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(data));
    return JSON.parse(td.decode(pt));
  }
  function bumpVaultTimer() {
    clearTimeout(S.vault.timer);
    if (S.vault.key) S.vault.timer = setTimeout(lockVault, 5 * 60 * 1000);
  }
  function lockVault() {
    S.vault.key = null; S.vault.items = []; clearTimeout(S.vault.timer);
    if (S.view === 'vault') renderShell();
  }

  async function viewVault() {
    const V = S.vault;
    if (V.meta === undefined) {
      const { data } = await S.sb.from('fv_vault_meta').select('*').eq('user_id', S.user.id).maybeSingle();
      V.meta = data || null;
    }
    if (!V.meta) {
      main().innerHTML = `<h2 class="h">Passwords</h2>
        <div class="card form">
          <p>Keep your passwords here, locked with a <b>master password</b>. They are scrambled on this phone before saving — nobody else in the family, not even the admin, can read them.</p>
          <p class="msg bad"><b>If you forget the master password, these passwords cannot be recovered by anyone.</b> Write it down and keep it somewhere safe at home.</p>
          <form id="vaultNew" class="form">
            <label>Choose a master password<input type="password" name="p1" minlength="8" required autocomplete="new-password"></label>
            <label>Type it again<input type="password" name="p2" minlength="8" required autocomplete="new-password"></label>
            <button class="btn primary big">Create my password safe</button></form></div>`;
      $('#vaultNew').onsubmit = async e => {
        e.preventDefault();
        const f = e.target;
        if (f.p1.value !== f.p2.value) return toast('The two passwords do not match.', true);
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const key = await deriveKey(f.p1.value, salt);
        const v = await encrypt(key, 'family-vault-ok');
        const { data, error } = await S.sb.from('fv_vault_meta').insert({ user_id: S.user.id, salt: b64(salt), iv: v.iv, verifier: v.data }).select().single();
        if (error) return toast(niceError(error), true);
        V.meta = data; V.key = key; V.items = []; bumpVaultTimer(); renderShell();
      };
      return;
    }
    if (!V.key) {
      main().innerHTML = `<h2 class="h">Passwords</h2>
        <form id="vaultOpen" class="card form"><div class="logo small">${ICON.key}</div>
          <label>Master password<input type="password" name="pw" required autocomplete="current-password"></label>
          <button class="btn primary big">Unlock</button>
          <p class="muted small">Locks itself after 5 minutes.</p></form>`;
      $('#vaultOpen').onsubmit = async e => {
        e.preventDefault();
        const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Unlocking…';
        try {
          const key = await deriveKey(e.target.pw.value, unb64(V.meta.salt));
          await decrypt(key, V.meta.iv, V.meta.verifier);
          V.key = key;
          const { data } = await S.sb.from('fv_vault_items').select('*').eq('user_id', S.user.id);
          V.items = [];
          for (const r of data || []) { try { V.items.push({ id: r.id, ...(await decrypt(key, r.iv, r.data)) }); } catch { /* skip damaged */ } }
          bumpVaultTimer(); renderShell();
        } catch { btn.disabled = false; btn.textContent = 'Unlock'; toast('Wrong master password.', true); }
      };
      return;
    }
    bumpVaultTimer();
    const f = V.filter.toLowerCase();
    const list = V.items.filter(i => !f || [i.label, i.username, i.url, i.notes].join(' ').toLowerCase().includes(f))
      .sort((a, b) => (a.label || '').localeCompare(b.label || ''));
    main().innerHTML = `
      <div class="row between"><h2 class="h">Passwords</h2><span class="row small-gap"><button class="btn small" data-act="lockVault">Lock</button><button class="btn primary small" data-act="editSecret" data-id="">+ Add</button></span></div>
      <div class="searchbar">${ICON.search}<input id="vq" type="search" placeholder="Search passwords" value="${esc(V.filter)}"></div>
      <div class="list">${list.map(i => `<button class="secret card" data-act="showSecret" data-id="${i.id}"><b>${esc(i.label)}</b><span class="muted">${esc(i.username || '')}</span></button>`).join('') || '<div class="empty">No passwords saved yet.</div>'}</div>`;
    $('#vq').addEventListener('input', e => { V.filter = e.target.value; const p = e.target.selectionStart; viewVault().then(() => { const q = $('#vq'); q.focus(); q.setSelectionRange(p, p); }); });
  }
  function showSecret(id) {
    const i = S.vault.items.find(x => x.id === id); if (!i) return;
    bumpVaultTimer();
    const row = (label, val, secret) => val ? `<div class="secret-row"><span class="muted small">${label}</span><div class="row between"><code class="${secret ? 'blur' : ''}" ${secret ? 'data-act="reveal"' : ''}>${esc(val)}</code><button class="btn small" data-act="copy" data-v="${esc(val)}">Copy</button></div></div>` : '';
    openSheet(`<div class="sheet-head"><h2>${esc(i.label)}</h2><button class="icon-btn" data-act="closeSheet">${ICON.close}</button></div>
      ${row('Username / ID', i.username)}${row('Password', i.password, true)}${row('PIN', i.pin, true)}${row('Website / app', i.url)}
      ${i.notes ? `<div class="secret-row"><span class="muted small">Notes</span><pre class="notes">${esc(i.notes)}</pre></div>` : ''}
      <div class="row gap"><button class="btn" data-act="editSecret" data-id="${i.id}">Edit</button><button class="btn danger" data-act="deleteSecret" data-id="${i.id}">Delete</button></div>`);
  }
  function editSecret(id) {
    const i = S.vault.items.find(x => x.id === id) || {};
    openSheet(`<div class="sheet-head"><h2>${id ? 'Edit' : 'Add a password'}</h2><button class="icon-btn" data-act="closeSheet">${ICON.close}</button></div>
      <form id="secretForm" class="form">
        <label>What is it for?<input name="label" required value="${esc(i.label || '')}" placeholder="SBI net banking"></label>
        <label>Username / ID<input name="username" value="${esc(i.username || '')}" autocomplete="off"></label>
        <label>Password<div class="row small-gap"><input name="password" value="${esc(i.password || '')}" autocomplete="off"><button type="button" class="btn small" id="gen">Make one</button></div></label>
        <label>PIN (optional)<input name="pin" value="${esc(i.pin || '')}" autocomplete="off"></label>
        <label>Website or app (optional)<input name="url" value="${esc(i.url || '')}"></label>
        <label>Notes (optional)<textarea name="notes" rows="3">${esc(i.notes || '')}</textarea></label>
        <button class="btn primary big">Save</button></form>`);
    $('#gen').onclick = () => {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#$%&*';
      const r = crypto.getRandomValues(new Uint32Array(14));
      $('#secretForm').password.value = [...r].map(x => chars[x % chars.length]).join('');
    };
    $('#secretForm').onsubmit = async e => {
      e.preventDefault();
      const f = e.target;
      const obj = { label: f.label.value.trim(), username: f.username.value, password: f.password.value, pin: f.pin.value, url: f.url.value.trim(), notes: f.notes.value };
      const enc = await encrypt(S.vault.key, obj);
      const res = id ? await S.sb.from('fv_vault_items').update(enc).eq('id', id).select().single()
        : await S.sb.from('fv_vault_items').insert({ ...enc, user_id: S.user.id }).select().single();
      if (res.error) return toast(niceError(res.error), true);
      S.vault.items = S.vault.items.filter(x => x.id !== id).concat({ id: res.data.id, ...obj });
      closeSheet(); toast('Saved'); renderShell();
    };
  }
  async function deleteSecret(id) {
    if (!confirm('Delete this password?')) return;
    const { error } = await S.sb.from('fv_vault_items').delete().eq('id', id);
    if (error) return toast(niceError(error), true);
    S.vault.items = S.vault.items.filter(x => x.id !== id); closeSheet(); renderShell();
  }

  // =====================================================================
  //  More: expiring, logins, account, settings
  // =====================================================================
  async function viewMore() {
    const { data: exp } = await S.sb.from('fv_documents').select('id,title,expiry_date,member_id').not('expiry_date', 'is', null).order('expiry_date');
    const { data: sizes } = await S.sb.from('fv_documents').select('size_bytes');
    const used = (sizes || []).reduce((a, d) => a + (d.size_bytes || 0), 0);
    if (isAdmin()) await loadUsers();
    let mfaOn = false;
    try { const { data } = await S.sb.auth.mfa.listFactors(); mfaOn = (data.totp || []).some(f => f.status === 'verified'); } catch { /* ignore */ }
    const roleName = { pending: 'No access', viewer: 'Can view & search', uploader: 'Can add documents', admin: 'Admin' };
    main().innerHTML = `
      <h2 class="h">Valid-till dates</h2>
      <div class="card list-tight">${(exp || []).length ? exp.map(d => `<button class="exp-row" data-act="openDoc" data-id="${d.id}"><span>${esc(d.title)}</span><span>${expiryBadge(d.expiry_date) || `<span class="muted small">${fmtDate(d.expiry_date)}</span>`}</span></button>`).join('')
        : '<p class="muted">No documents with a valid-till date yet. Driving licences, passports, insurance and PUC get one automatically when the date can be read.</p>'}</div>

      ${isAdmin() ? `<h2 class="h">Family logins</h2>
      <div class="card list-tight">${S.users.map(u => `
        <div class="user-row ${u.role === 'pending' ? 'pending' : ''}">
          <div><b>${esc(u.display_name)}</b> <span class="muted small">${esc(u.mobile || '')}</span>${u.user_id === S.user.id ? ' <span class="badge">you</span>' : ''}${u.role === 'pending' ? ' <span class="badge amber">waiting</span>' : ''}</div>
          <div class="row small-gap wrap">
            <select class="select-sm" data-user="${u.user_id}" data-k="role">${Object.entries(roleName).map(([k, l]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <select class="select-sm" data-user="${u.user_id}" data-k="member"><option value="">Is which family member?</option>${S.members.map(m => `<option value="${m.id}" ${u.member_id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
            <button class="btn small primary" data-act="saveUser" data-id="${u.user_id}">Save</button>
          </div></div>`).join('')}
        <p class="muted small">Linking a login to a family member lets that person see their own <b>private</b> documents. New family members create their own login from the sign-in screen, then appear here.</p></div>` : ''}

      <h2 class="h">My account</h2>
      <div class="card list-tight">
        <div class="kv"><span>Signed in as</span><b>${esc(S.me.display_name)} · ${esc(S.me.mobile || '')}</b></div>
        <div class="kv"><span>Access</span><b>${roleName[S.me.role]}</b></div>
        <button class="exp-row" data-act="changePassword"><span>Change my password</span><span>›</span></button>
        <button class="exp-row" data-act="${mfaOn ? 'mfaOff' : 'mfaOn'}"><span>2-step login (authenticator app)</span><span class="badge ${mfaOn ? 'green' : ''}">${mfaOn ? 'On' : 'Off'}</span></button>
      </div>

      <h2 class="h">Settings on this device</h2>
      <div class="card list-tight">
        <label class="check"><input type="checkbox" data-pref="hindi" ${pref('hindi', false) ? 'checked' : ''}><span>Also read Hindi text <span class="muted small">(slower; downloads about 10 MB once)</span></span></label>
        <label class="check"><input type="checkbox" data-pref="shrink" ${pref('shrink', true) ? 'checked' : ''}><span>Shrink large photos before saving <span class="muted small">(saves storage; PDFs are never changed)</span></span></label>
        <div class="kv"><span>Storage used by documents you can see</span><b>${fmtSize(used)} of 1 GB free plan</b></div>
      </div>
      <button class="btn big" data-act="signOut">Sign out</button>
      <p class="muted small center">Private documents are visible only to the person they belong to and to whoever uploaded them — not even the admin sees them.</p>`;
  }
  async function saveUser(userId) {
    const role = $(`[data-user="${userId}"][data-k="role"]`).value;
    const member = $(`[data-user="${userId}"][data-k="member"]`).value || null;
    const { error } = await S.sb.rpc('fv_set_user', { p_user: userId, p_role: role, p_member: member, p_name: null });
    if (error) return toast(niceError(error), true);
    toast('Access updated');
    if (userId === S.user.id) { const { data } = await S.sb.from('fv_users').select('*').eq('user_id', userId).single(); S.me = data; }
    renderShell();
  }
  function changePassword() {
    openSheet(`<div class="sheet-head"><h2>Change password</h2><button class="icon-btn" data-act="closeSheet">${ICON.close}</button></div>
      <form id="pwForm" class="form"><label>New password<input type="password" name="p1" minlength="6" required autocomplete="new-password"></label>
      <label>Type it again<input type="password" name="p2" minlength="6" required autocomplete="new-password"></label>
      <button class="btn primary big">Change password</button></form>`);
    $('#pwForm').onsubmit = async e => {
      e.preventDefault();
      const f = e.target;
      if (f.p1.value !== f.p2.value) return toast('The two passwords do not match.', true);
      const { error } = await S.sb.auth.updateUser({ password: f.p1.value });
      if (error) return toast(niceError(error), true);
      closeSheet(); toast('Password changed');
    };
  }
  async function mfaOn() {
    try {
      const { data: list } = await S.sb.auth.mfa.listFactors();
      for (const f of (list.all || list.totp || [])) if (f.status !== 'verified') await S.sb.auth.mfa.unenroll({ factorId: f.id });
      const { data, error } = await S.sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Family Vault ' + Date.now() });
      if (error) throw error;
      openSheet(`<div class="sheet-head"><h2>Turn on 2-step login</h2><button class="icon-btn" data-act="closeSheet">${ICON.close}</button></div>
        <ol class="steps"><li>Install <b>Google Authenticator</b> on your phone.</li>
        <li>Tap <b>+</b> → <b>Scan a QR code</b> and scan this. (On the same phone? Choose <b>Enter a setup key</b> and type the key below.)</li></ol>
        <div class="qr"><img src="${esc(data.totp.qr_code)}" alt="QR code"></div>
        <p class="center"><code class="setup-key">${esc(data.totp.secret)}</code></p>
        <form id="mfaSet" class="form"><label>Type the 6-digit code it shows<input name="code" inputmode="numeric" maxlength="6" class="code-input" required></label>
        <button class="btn primary big">Turn on</button></form>
        <p class="muted small">From now on, signing in will also ask for this code. Lose the phone and the admin can reset you by deleting your login in Supabase.</p>`);
      $('#mfaSet').onsubmit = async e => {
        e.preventDefault();
        const { error: err } = await S.sb.auth.mfa.challengeAndVerify({ factorId: data.id, code: e.target.code.value.replace(/\D/g, '') });
        if (err) return toast('That code did not work — try the newest one.', true);
        closeSheet(); toast('2-step login is on'); renderShell();
      };
    } catch (e) { toast(niceError(e), true); }
  }
  async function mfaOff() {
    if (!confirm('Turn off 2-step login?')) return;
    const { data } = await S.sb.auth.mfa.listFactors();
    for (const f of data.totp || []) {
      const { error } = await S.sb.auth.mfa.unenroll({ factorId: f.id });
      if (error) return toast(niceError(error), true);
    }
    await S.sb.auth.refreshSession();
    toast('2-step login is off'); renderShell();
  }

  // =====================================================================
  //  Taps and typing
  // =====================================================================
  const ACT = {
    showSignIn: () => renderLogin('in'), showSignUp: () => renderLogin('up'),
    signOut: async () => { lockVault(); finishBatch(); await S.sb.auth.signOut(); S.me = null; S.user = null; S.vault.meta = undefined; S.urls.clear(); renderLogin('in'); },
    recheck: () => afterLogin(),
    go: el => go(el.dataset.v),
    closeSheet,
    clearQ: () => { S.q = ''; viewDocs(); },
    filterMember: el => { S.filterMember = el.dataset.id; $$('.chips .chip').forEach(c => c.classList.toggle('on', c === el)); runSearch(); },
    showMemberDocs: el => { S.filterMember = el.dataset.id; S.q = ''; go('docs'); },
    openDoc: el => openDoc(el.dataset.id),
    toggleSelecting: () => { S.selecting = !S.selecting; S.selected.clear(); viewDocs(); },
    toggleSel: el => {
      const id = el.dataset.id;
      if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id);
      el.classList.toggle('picked', S.selected.has(id));
      const p = el.querySelector('.pick'); if (p) p.textContent = S.selected.has(id) ? '✓' : '';
      renderSelBar();
    },
    sendSelected: () => sendSheet([...S.selected]),
    sendOne: el => sendSheet([el.dataset.id]),
    shareFiles: el => shareFiles(el),
    sendLink: el => sendLink(el.dataset.how),
    manageContacts: () => manageContacts(),
    deleteContact: async el => {
      const { error } = await S.sb.from('fv_contacts').delete().eq('id', el.dataset.id);
      if (error) return toast(niceError(error), true);
      S.sending.contacts = S.sending.contacts.filter(c => c.id !== el.dataset.id); manageContacts();
    },
    backToSend: () => sendSheet(S.sending.docs.map(d => d.id)),
    viewFile: el => viewFile(el.dataset.id, false),
    downloadFile: el => viewFile(el.dataset.id, true),
    editDoc: el => editDoc(el.dataset.id),
    deleteDoc: el => deleteDoc(el.dataset.id),
    stopBatch: () => { if (S.batch) S.batch.stop = true; toast('Stopping after this file…'); },
    cancelBatch: () => {
      const B = S.batch;
      if (B && B.phase !== 'done' && B.items.some(i => i.include && i.status !== 'saved') && !confirm('Close without saving the ticked files?')) return;
      finishBatch(); go('add');
    },
    saveBatch: () => saveBatch(),
    tickAll: el => {
      const on = el.dataset.on === '1';
      $$('.item', el.closest('.group')).forEach(box => { const it = S.batch.items.find(i => i.uid === box.dataset.uid); if (it && it.status !== 'saved' && !it.tooBig) it.include = on; });
      renderBatch();
    },
    previewItem: el => {
      const it = S.batch && S.batch.items.find(i => i.uid === el.dataset.uid);
      if (it) { const u = URL.createObjectURL(it.file); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60000); }
    },
    editMember: el => editMember(el.dataset.id), deleteMember: el => deleteMember(el.dataset.id),
    lockVault, showSecret: el => showSecret(el.dataset.id), editSecret: el => editSecret(el.dataset.id), deleteSecret: el => deleteSecret(el.dataset.id),
    reveal: el => el.classList.toggle('blur'),
    copy: async el => { try { await navigator.clipboard.writeText(el.dataset.v); toast('Copied'); } catch { toast('Could not copy', true); } bumpVaultTimer(); },
    saveUser: el => saveUser(el.dataset.id), changePassword, mfaOn, mfaOff
  };
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || !ACT[el.dataset.act]) return;
    if (el.tagName === 'A' || el.tagName === 'BUTTON') e.preventDefault();
    if (el.dataset.act !== 'closeSheet' && el.closest('#sheet') && ['openDoc'].includes(el.dataset.act)) closeSheet();
    ACT[el.dataset.act](el, e);
  });
  document.addEventListener('change', e => {
    if (e.target.dataset.f) onItemChange(e.target);
    if (e.target.dataset.pref) setPref(e.target.dataset.pref, e.target.checked);
  });
  document.addEventListener('input', e => { if (e.target.dataset.f === 'title') onItemChange(e.target); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && S.vault.key) { clearTimeout(S.vault.timer); S.vault.timer = setTimeout(lockVault, 60 * 1000); }
    else bumpVaultTimer();
  });
  window.addEventListener('beforeunload', e => { if (S.batch && ['reading', 'saving'].includes(S.batch.phase)) { e.preventDefault(); e.returnValue = ''; } });

  boot().catch(e => renderPlain(`<h2>Could not start</h2><p>${esc(niceError(e))}</p>`));
})();
