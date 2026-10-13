/* =====================================================================
   SITE MATRIX 3D — shared module (auth, license, projects, payments)
   Demo-grade localStorage persistence. No DOM access at module level,
   so this file is safe to import in any context.
   ===================================================================== */

export const PRICE_NGN = 2000;
export const fmtNGN = (n) => '₦' + Number(n).toLocaleString('en-NG');
export const SUB_DAYS = 30; // subscription billing period (days)
export const SUB_LABEL = fmtNGN(PRICE_NGN) + '/month'; // e.g. ₦2,000/month

function fmtSubDate(ts) {
  try {
    return new Date(ts).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (e) { return ''; }
}

/* ---------------- owner access (site administrator) ----------------
   - ADMIN_EMAILS: accounts that ALWAYS have full access (no payment).
     Put your own email here — it is auto-activated on sign-up/login.
   - OWNER_CODE: master code that unlocks Full Access instantly from the
     checkout ("Have an owner code?"). Keep it secret; change it to
     something only you know. */
export const ADMIN_EMAILS = [
  'owner@sitematrix3d.com' // <-- REPLACE with your own email address
];
export const OWNER_CODE = 'MATRIX-OWNER-2026'; // <-- change to your own secret code

export function isAdminEmail(email) {
  if (!email) return false;
  const low = ADMIN_EMAILS.map((e) => String(e).toLowerCase());
  return low.includes(String(email).toLowerCase());
}

export function isOwner() {
  const s = getSession();
  return !!(s && s.email && isAdminEmail(s.email));
}

const K = {
  users: 'sitematrix3d.users',
  session: 'sitematrix3d.session',
  guestActivated: 'sitematrix3d.guestActivated',
  projects: (owner) => 'sitematrix3d.projects.' + owner,
  current: (owner) => 'sitematrix3d.current.' + owner
};

function read(key, fb = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fb;
  } catch (e) { return fb; }
}

function write(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; }
  catch (e) { return false; }
}

export const uid = (p = 'id') =>
  p + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

export function fmtDate(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return 'just now';
  if (diff < 3600 * 1000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400 * 1000) return Math.floor(diff / 3600000) + 'h ago';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/* ---------------- users / auth ---------------- */

export function getUsers() {
  const u = read(K.users, {});
  return u && typeof u === 'object' ? u : {};
}

function saveUsers(u) { return write(K.users, u); }

// NOTE: demo-grade obfuscation only (not real security).
const hashPass = (s) => {
  try { return btoa(unescape(encodeURIComponent('sm3d$' + s))); }
  catch (e) { return 'sm3d$' + s; }
};

export function publicUser(u) {
  return u ? { name: u.name, email: u.email, activated: !!u.activated } : null;
}

export function signup(name, email, password) {
  name = (name || '').trim();
  email = (email || '').trim().toLowerCase();
  password = password || '';
  if (name.length < 2) return { ok: false, error: 'Please enter your full name.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'Please enter a valid email address.' };
  if (password.length < 6) return { ok: false, error: 'Password must be at least 6 characters.' };
  const users = getUsers();
  if (users[email]) return { ok: false, error: 'An account with this email already exists. Please log in.' };
  const _isOwnerAcc = isAdminEmail(email);
  users[email] = { name, email, pass: hashPass(password), activated: _isOwnerAcc, createdAt: Date.now() };
  if (_isOwnerAcc) users[email].activatedAt = Date.now();
  saveUsers(users);
  setSession({ email, at: Date.now() });
  return { ok: true, user: publicUser(users[email]) };
}

export function login(email, password) {
  email = (email || '').trim().toLowerCase();
  const u = getUsers()[email];
  if (!u || u.pass !== hashPass(password || '')) {
    return { ok: false, error: 'Incorrect email or password.' };
  }
  setSession({ email, at: Date.now() });
  if (isAdminEmail(email)) {
    const _users = getUsers();
    if (_users[email] && !_users[email].activated) {
      _users[email].activated = true;
      _users[email].activatedAt = Date.now();
      saveUsers(_users);
    }
  }
  return { ok: true, user: publicUser(getUsers()[email]) };
}

export function getCurrentUser() {
  const s = getSession();
  if (!s || !s.email) return null;
  return publicUser(getUsers()[s.email]) || null;
}

/* ---------------- session ---------------- */

export function getSession() { return read(K.session, null); }
export function setSession(s) { write(K.session, s); }
export function logout() {
  try { localStorage.removeItem(K.session); } catch (e) { /* ignore */ }
}
export function ensureGuestSession() {
  if (!getSession()) setSession({ guest: true, at: Date.now() });
}
export function getOwner() {
  const s = getSession();
  if (s && s.email) return 'u_' + s.email;
  return 'guest';
}

/* ---------------- license (activation) ---------------- */

const SUB_MS = SUB_DAYS * 86400000;
const GUEST_SUB_END = 'sitematrix3d.guestSubEnd';

function grantSub(user) {
  const now = Date.now();
  const base = Math.max(now, user.subEnd || 0);
  if (!user.subStart) user.subStart = now;
  user.subEnd = base + SUB_MS;
  user.activated = true; // legacy compat
  if (!user.activatedAt) user.activatedAt = now;
  user.lastRenewedAt = now;
  return user;
}

function migrateLegacySub(user) {
  // honor old one-time activations with a fresh billing period, once
  if (user.activated && !user.subEnd) {
    user.subStart = Date.now();
    user.subEnd = Date.now() + SUB_MS;
    return true;
  }
  return false;
}

export function getSubscription() {
  const s = getSession();
  if (s && s.email) {
    if (isAdminEmail(s.email)) return { status: 'lifetime', daysLeft: Infinity, endsAt: null };
    const users = getUsers();
    const u = users[s.email];
    if (!u) return { status: 'none', daysLeft: 0, endsAt: null };
    if (migrateLegacySub(u)) saveUsers(users);
    if (u.subEnd && u.subEnd > Date.now()) {
      return { status: 'active', daysLeft: Math.ceil((u.subEnd - Date.now()) / 86400000), endsAt: u.subEnd };
    }
    if (u.subEnd) return { status: 'expired', daysLeft: 0, endsAt: u.subEnd };
    return { status: 'none', daysLeft: 0, endsAt: null };
  }
  if (s && s.guest) {
    const end = Number(read(GUEST_SUB_END, 0)) || 0;
    if (end > Date.now()) {
      return { status: 'active', daysLeft: Math.ceil((end - Date.now()) / 86400000), endsAt: end };
    }
    if (end) return { status: 'expired', daysLeft: 0, endsAt: end };
    if (read(K.guestActivated, false) === true) {
      const e = Date.now() + SUB_MS; // honor legacy guest activation once
      write(GUEST_SUB_END, e);
      return { status: 'active', daysLeft: SUB_DAYS, endsAt: e };
    }
  }
  return { status: 'none', daysLeft: 0, endsAt: null };
}

export function isActivated() {
  const st = getSubscription().status;
  return st === 'active' || st === 'lifetime';
}

export function setActivated() {
  // activates a NEW subscription or RENEWS (extends) an existing one
  const s = getSession();
  if (s && s.email) {
    const users = getUsers();
    if (users[s.email]) {
      grantSub(users[s.email]);
      saveUsers(users);
    }
  } else {
    const now = Date.now();
    const base = Math.max(now, Number(read(GUEST_SUB_END, 0)) || 0);
    write(GUEST_SUB_END, base + SUB_MS);
    write(K.guestActivated, true);
  }
}

/* ---------------- projects ---------------- */

export function getProjects(owner) {
  const arr = read(K.projects(owner || getOwner()), []);
  return Array.isArray(arr) ? arr : [];
}

export function saveProjects(owner, list) {
  write(K.projects(owner || getOwner()), list || []);
}

export function createProject(owner, name, objects = []) {
  const o = owner || getOwner();
  const rec = {
    id: uid('proj'),
    name: name || 'Untitled Project',
    objects: Array.isArray(objects) ? objects : [],
    thumb: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  const list = getProjects(o);
  list.push(rec);
  saveProjects(o, list);
  return rec;
}

export function touchProject(owner, id, patch = {}) {
  const o = owner || getOwner();
  const list = getProjects(o).map((p) =>
    p.id === id ? { ...p, ...patch, updatedAt: patch.updatedAt || Date.now() } : p);
  saveProjects(o, list);
}

export function deleteProject(owner, id) {
  const o = owner || getOwner();
  saveProjects(o, getProjects(o).filter((p) => p.id !== id));
}

export function getCurrentProjectId(owner) {
  try { return localStorage.getItem(K.current(owner || getOwner())); }
  catch (e) { return null; }
}

export function setCurrentProjectId(owner, id) {
  try { localStorage.setItem(K.current(owner || getOwner()), id); }
  catch (e) { /* ignore */ }
}

/* ---------------- payment (Paystack live with demo fallback) ---------------- */

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Fetched once per page load from /api/config (only contains public key)
let _paystackCfg = null;
async function getPaystackCfg() {
  if (_paystackCfg) return _paystackCfg;
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    const j = await r.json();
    _paystackCfg = (j && j.ok && j.paystack) ? j.paystack : { publicKey: '', enabled: false };
  } catch (e) {
    _paystackCfg = { publicKey: '', enabled: false };
  }
  return _paystackCfg;
}

// Dynamically load Paystack's inline popup JS (paystack.js). Safe to call multiple times.
function loadPaystackJs() {
  if (window.PaystackPop) return Promise.resolve(window.PaystackPop);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://js.paystack.co/v1/inline.js';
    s.async = true;
    s.onload = () => resolve(window.PaystackPop);
    s.onerror = () => reject(new Error('Paystack script failed to load'));
    document.head.appendChild(s);
  });
}

// Verify a payment reference with our server (server checks Paystack with secret key)
async function verifyPaystackRef(reference) {
  const r = await fetch('/api/paystack/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'verification failed');
  return j.data;
}

export function closePayModal() {
  const ov = document.getElementById('pay-overlay');
  if (ov) {
    if (ov._escHandler) document.removeEventListener('keydown', ov._escHandler);
    ov.remove();
  }
  document.body.style.overflow = '';
}

/**
 * Open the demo checkout modal.
 * opts: { email, title, subtitle, successLabel, successHref, onSuccess }
 */
export async function openPayModal(opts = {}) {
  closePayModal();

  const overlay = document.createElement('div');
  overlay.id = 'pay-overlay';
  overlay.innerHTML =
    '<div class="pay-card" role="dialog" aria-modal="true">' +
      '<button class="pay-close" type="button" aria-label="Close">✕</button>' +
      '<div class="pay-head">' +
        '<div class="pay-logo"><svg viewBox="0 0 48 48" aria-hidden="true"><polygon points="6,16.5 24,27 24,44 6,33.5" fill="#00b8e6" stroke="rgba(234,252,255,.9)" stroke-width="1.4" stroke-linejoin="round"/><polygon points="42,16.5 24,27 24,44 42,33.5" fill="#7c5cff" stroke="rgba(234,252,255,.9)" stroke-width="1.4" stroke-linejoin="round"/><polygon points="24,6 42,16.5 24,27 6,16.5" fill="#8ff7ff" stroke="rgba(234,252,255,.9)" stroke-width="1.4" stroke-linejoin="round"/><line x1="24" y1="6" x2="24" y2="27" stroke="#0b3a52" stroke-width="1.4" opacity=".55"/><line x1="6" y1="16.5" x2="42" y2="16.5" stroke="#0b3a52" stroke-width="1.4" opacity=".55"/><circle cx="24" cy="16.5" r="2.4" fill="#0b1626" stroke="#eafcff" stroke-width="1"/></svg></div>' +
        '<div><h3>' + escapeHtml(opts.title || 'Subscribe for Full Access') + '</h3>' +
        '<p class="pay-sub">' + escapeHtml(opts.subtitle || 'Monthly subscription for SITE MATRIX 3D Studio.') + '</p></div>' +
      '</div>' +
      '<div class="pay-price"><span class="pay-amount">' + fmtNGN(PRICE_NGN) + '</span>' +
      '<span class="pay-once">per month • cancel anytime</span></div>' +
      '<ul class="pay-feats">' +
        '<li>📁 Unlimited projects + project library</li>' +
        '<li>📤 Export / 📥 Import project files</li>' +
        '<li>👻 Full Holographic Studio (Solid · Exploded · Volumetric)</li>' +
        '<li>💾 Save, autosave &amp; PNG screenshots</li>' +
      '</ul>' +
      '<div class="pay-email-row hidden"><span>Account</span><strong class="pay-email"></strong></div>' +
      '<div class="pay-owner-toggle"><button type="button" class="pay-owner-link">🔑 Have an owner code?</button></div>' +
      '<div class="pay-owner-row hidden">' +
        '<input type="text" class="pay-owner-code" placeholder="Enter owner code" autocomplete="off" />' +
        '<button type="button" class="pay-owner-btn">Unlock</button>' +
      '</div>' +
      '<div class="pay-error hidden pay-owner-error"></div>' +
      '<form class="pay-form" novalidate>' +
        '<div class="pay-live-fields hidden">' +
          '<label class="pay-email-label">Email' +
            '<input type="email" class="pay-live-email" placeholder="you@example.com" autocomplete="email" required />' +
          '</label>' +
          '<div class="pay-error hidden"></div>' +
          '<button type="submit" class="pay-btn">🔒 Pay securely with Paystack — ' + SUB_LABEL + '</button>' +
          '<p class="pay-secure">🔐 Checkout secured by <b>Paystack</b> • Cards, Bank, USSD, Transfer, Apple/Google Pay.<br/>You will be redirected to Paystack to complete your payment.</p>' +
        '</div>' +
        '<div class="pay-demo-fields">' +
          '<label>Card number' +
            '<input type="text" class="pay-cardnum" inputmode="numeric" placeholder="4242 4242 4242 4242" maxlength="19" autocomplete="cc-number" />' +
          '</label>' +
          '<div class="pay-grid2">' +
            '<label>Expiry<input type="text" class="pay-exp" placeholder="MM/YY" maxlength="5" inputmode="numeric" autocomplete="cc-exp" /></label>' +
            '<label>CVV<input type="password" class="pay-cvv" placeholder="123" maxlength="4" inputmode="numeric" autocomplete="cc-csc" /></label>' +
          '</div>' +
          '<div class="pay-error hidden"></div>' +
          '<button type="submit" class="pay-btn">🔒 Subscribe — ' + SUB_LABEL + '</button>' +
          '<p class="pay-secure">🔐 Secured checkout • <b>Demo mode — no real charge is made.</b><br/>Use any test card, e.g. 4242 4242 4242 4242.</p>' +
        '</div>' +
      '</form>' +
      '<div class="pay-success hidden">' +
        '<div class="pay-check">✓</div>' +
        '<h3 class="pay-success-title">Subscription Active</h3>' +
        '<p class="pay-sub">Full Access unlocked — enjoy unlimited projects.</p>' +
        '<p class="pay-until"></p>' +
        '<div class="pay-receipt">Receipt: <span class="pay-receipt-id"></span></div>' +
        '<button type="button" class="pay-btn pay-done">Continue</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  const q = (sel) => overlay.querySelector(sel);
  let processing = false;

  if (opts.email) {
    q('.pay-email-row').classList.remove('hidden');
    q('.pay-email').textContent = opts.email;
    const liveEmail = q('.pay-live-email');
    if (liveEmail) {
      liveEmail.value = opts.email;
      liveEmail.readOnly = true;
      liveEmail.style.opacity = '0.75';
    }
  }

  // Determine live vs demo mode once
  const cfg = await getPaystackCfg();
  const live = !!(cfg && cfg.enabled && cfg.publicKey);
  const liveWrap = q('.pay-live-fields');
  const demoWrap = q('.pay-demo-fields');
  const form = q('.pay-form');

  if (live) {
    liveWrap.classList.remove('hidden');
    demoWrap.classList.add('hidden');
  } else {
    liveWrap.classList.add('hidden');
    demoWrap.classList.remove('hidden');
  }

  const errBox = q('.pay-error') || form.querySelector('.pay-error');
  const showError = (msg) => {
    const eb = q('.pay-live-fields .pay-error') || q('.pay-demo-fields .pay-error');
    eb.textContent = msg;
    eb.classList.remove('hidden');
  };
  const hideError = () => {
    form.querySelectorAll('.pay-error').forEach((el) => el.classList.add('hidden'));
  };

  function showSuccess(receiptId, titleOverride) {
    setActivated();
    form.classList.add('hidden');
    q('.pay-owner-row').classList.add('hidden');
    q('.pay-owner-toggle').classList.add('hidden');
    q('.pay-success-title').textContent = titleOverride || 'Subscription Active';
    q('.pay-until').textContent = 'Active until ' + fmtSubDate(getSubscription().endsAt) + ' — renews monthly, cancel anytime.';
    const s = q('.pay-success');
    s.classList.remove('hidden');
    q('.pay-receipt-id').textContent = receiptId;
    const done = q('.pay-done');
    done.textContent = opts.successLabel || 'Continue Building →';
    done.addEventListener('click', () => {
      if (opts.successHref) window.location.href = opts.successHref;
      else closePayModal();
    });
    if (typeof opts.onSuccess === 'function') {
      try { opts.onSuccess(); } catch (err) { /* ignore */ }
    }
  }

  // --- demo card input formatting ---
  const cn = q('.pay-cardnum');
  if (cn) cn.addEventListener('input', (e) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 16);
    e.target.value = digits.replace(/(\d{4})(?=\d)/g, '$1 ');
  });
  const ep = q('.pay-exp');
  if (ep) ep.addEventListener('input', (e) => {
    let d = e.target.value.replace(/\D/g, '').slice(0, 4);
    e.target.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d;
  });
  const cv = q('.pay-cvv');
  if (cv) cv.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (processing) return;
    hideError();

    if (live) {
      // ---------- LIVE PAYSTACK FLOW ----------
      const emailInput = q('.pay-live-email');
      const email = (emailInput.value || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        emailInput.focus();
        return showError('Please enter a valid email address for your receipt.');
      }
      processing = true;
      const btn = form.querySelector('.pay-btn');
      btn.disabled = true;
      btn.classList.add('processing');
      btn.textContent = 'Opening Paystack…';
      try {
        const PaystackPop = await loadPaystackJs();
        const handler = PaystackPop.setup({
          key: cfg.publicKey,
          email,
          amount: PRICE_NGN * 100, // kobo
          currency: 'NGN',
          ref: 'SM3D-' + Date.now().toString(36).toUpperCase() +
               '-' + Math.floor(100000 + Math.random() * 900000),
          metadata: {
            custom_fields: [
              { display_name: 'Plan', variable_name: 'plan', value: 'SITE MATRIX 3D Full Access Monthly' },
              { display_name: 'App', variable_name: 'app', value: 'SITE MATRIX 3D' },
            ],
          },
          callback: async (resp) => {
            try {
              btn.textContent = 'Verifying payment…';
              const data = await verifyPaystackRef(resp.reference);
              showSuccess('PSK-' + (data.reference || resp.reference));
            } catch (vErr) {
              processing = false;
              btn.disabled = false;
              btn.classList.remove('processing');
              btn.textContent = '🔒 Pay securely with Paystack — ' + SUB_LABEL;
              showError('Payment could not be verified: ' + (vErr.message || 'try again'));
            }
          },
          onClose: () => {
            processing = false;
            btn.disabled = false;
            btn.classList.remove('processing');
            btn.textContent = '🔒 Pay securely with Paystack — ' + SUB_LABEL;
          },
        });
        handler.openIframe();
        // Re-enable the button a moment after popup opens so users can try again if they close it
        setTimeout(() => {
          if (processing) {
            btn.disabled = false;
            btn.classList.remove('processing');
            btn.textContent = '🔒 Pay securely with Paystack — ' + SUB_LABEL;
          }
        }, 3500);
      } catch (err) {
        processing = false;
        btn.disabled = false;
        btn.classList.remove('processing');
        btn.textContent = '🔒 Pay securely with Paystack — ' + SUB_LABEL;
        showError('Could not load Paystack: ' + (err.message || 'check your connection'));
      }
      return;
    }

    // ---------- DEMO FLOW (no keys configured) ----------
    const num = (q('.pay-cardnum').value || '').replace(/\D/g, '');
    const exp = q('.pay-exp').value;
    const cvv = q('.pay-cvv').value;
    if (num.length !== 16) return showError('Please enter a valid 16-digit card number.');
    const m = exp.match(/^(0[1-9]|1[0-2])\/(\d{2})$/);
    if (!m) return showError('Please enter the card expiry as MM/YY.');
    if (cvv.length < 3) return showError('Please enter the 3-digit CVV.');
    processing = true;
    const btn = form.querySelector('.pay-btn');
    btn.disabled = true;
    btn.classList.add('processing');
    btn.textContent = 'Processing payment…';
    setTimeout(() => {
      showSuccess('SM3D-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(1000 + Math.random() * 9000));
    }, 1500);
  });

  // owner master-code unlock (for the site owner — no card needed)
  q('.pay-owner-link').addEventListener('click', () => {
    q('.pay-owner-row').classList.toggle('hidden');
    q('.pay-owner-error').classList.add('hidden');
    const _inp = q('.pay-owner-code');
    if (_inp && !q('.pay-owner-row').classList.contains('hidden')) _inp.focus();
  });
  const doOwnerUnlock = () => {
    if (processing) return;
    const err = q('.pay-owner-error');
    const val = (q('.pay-owner-code').value || '').trim();
    if (val !== OWNER_CODE) {
      err.textContent = 'Invalid owner code.';
      err.classList.remove('hidden');
      return;
    }
    processing = true;
    setActivated();
    q('.pay-success-title').textContent = 'Owner Access Unlocked';
    q('.pay-until').textContent = isOwner() ? 'Lifetime access — no expiry, no renewal needed.' : 'Active until ' + fmtSubDate(getSubscription().endsAt) + '.';
    q('.pay-form').classList.add('hidden');
    q('.pay-owner-row').classList.add('hidden');
    q('.pay-owner-toggle').classList.add('hidden');
    const _s = q('.pay-success');
    _s.classList.remove('hidden');
    q('.pay-receipt-id').textContent = 'OWNER-' + Date.now().toString(36).toUpperCase();
    const _done = q('.pay-done');
    _done.textContent = opts.successLabel || 'Continue Building →';
    _done.addEventListener('click', () => {
      if (opts.successHref) window.location.href = opts.successHref;
      else closePayModal();
    });
    if (typeof opts.onSuccess === 'function') {
      try { opts.onSuccess(); } catch (err2) { /* ignore */ }
    }
  };
  q('.pay-owner-btn').addEventListener('click', doOwnerUnlock);
  q('.pay-owner-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doOwnerUnlock(); }
  });

  q('.pay-close').addEventListener('click', () => { if (!processing) closePayModal(); });
  overlay.addEventListener('click', (e) => {
    if (!processing && e.target === overlay) closePayModal();
  });
  const esc = (e) => { if (!processing && e.key === 'Escape') closePayModal(); };
  overlay._escHandler = esc;
  document.addEventListener('keydown', esc);

  setTimeout(() => { const c = q('.pay-cardnum'); if (c) c.focus(); }, 60);
}
