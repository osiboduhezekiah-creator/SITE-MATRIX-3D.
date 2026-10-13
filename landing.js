/* SITE MATRIX 3D — landing page logic (auth, demo, payments, bg animation) */

import {
  signup, login, logout, getSession, getCurrentUser, ensureGuestSession,
  openPayModal, PRICE_NGN, fmtNGN, isOwner
} from './common.js?v=6';

const $ = (id) => document.getElementById(id);

/* ---------------- animated background ---------------- */
(function bgAnim() {
  const canvas = $('bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0;
  const parts = [];

  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    W = canvas.width = Math.max(2, Math.floor(r.width));
    H = canvas.height = Math.max(2, Math.floor(r.height));
  }
  resize();
  window.addEventListener('resize', resize);

  for (let i = 0; i < 90; i++) {
    parts.push({
      x: Math.random(), y: Math.random(),
      s: 0.6 + Math.random() * 1.8,
      v: 0.0004 + Math.random() * 0.0014,
      o: 0.25 + Math.random() * 0.6,
      hue: Math.random() < 0.75 ? '0,212,255' : '124,92,255'
    });
  }

  let scanY = 0;
  function frame() {
    ctx.clearRect(0, 0, W, H);
    const horizon = H * 0.62;

    // perspective grid below horizon
    ctx.strokeStyle = 'rgba(0,212,255,0.13)';
    ctx.lineWidth = 1;
    const off = (performance.now() / 40) % 46;
    for (let i = 0; i < 14; i++) {
      const y = horizon + Math.pow(i / 13, 1.8) * (H - horizon) + off * (i / 13);
      if (y > H) continue;
      ctx.beginPath();
      ctx.moveTo(0, Math.min(y, H));
      ctx.lineTo(W, Math.min(y, H));
      ctx.stroke();
    }
    for (let i = -12; i <= 12; i++) {
      ctx.beginPath();
      ctx.moveTo(W / 2 + i * W * 0.02, horizon);
      ctx.lineTo(W / 2 + i * W * 0.12, H);
      ctx.stroke();
    }
    // horizon glow
    const g = ctx.createLinearGradient(0, horizon - 24, 0, horizon + 24);
    g.addColorStop(0, 'rgba(0,212,255,0)');
    g.addColorStop(0.5, 'rgba(0,212,255,0.28)');
    g.addColorStop(1, 'rgba(0,212,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon - 24, W, 48);

    // rising particles
    for (const p of parts) {
      p.y -= p.v;
      if (p.y < -0.02) { p.y = 1.02; p.x = Math.random(); }
      ctx.fillStyle = 'rgba(' + p.hue + ',' + p.o + ')';
      ctx.beginPath();
      ctx.arc(p.x * W, p.y * H, p.s, 0, Math.PI * 2);
      ctx.fill();
    }

    // vertical scan sweep
    scanY = (scanY + 1.6) % (W + 300);
    const sg = ctx.createLinearGradient(scanY - 150, 0, scanY, 0);
    sg.addColorStop(0, 'rgba(0,212,255,0)');
    sg.addColorStop(1, 'rgba(0,212,255,0.07)');
    ctx.fillStyle = sg;
    ctx.fillRect(scanY - 150, 0, 150, H);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();

/* ---------------- nav session state ---------------- */
function renderNav() {
  const s = getSession();
  const user = getCurrentUser();
  const showUser = !!(s && (user || s.guest));
  $('nav-auth').classList.toggle('hidden', showUser);
  $('nav-user').classList.toggle('hidden', !showUser);
  if (showUser) {
    $('nav-chip').textContent = user ? ((isOwner() ? '👑 ' : '👤 ') + user.name) : '👤 Guest (demo)';
  }
}

$('nav-logout').addEventListener('click', () => {
  logout();
  renderNav();
});

/* ---------------- auth modal ---------------- */
function openAuth(tab) {
  $('auth-modal').classList.remove('hidden');
  setAuthTab(tab || 'signup');
}
function closeAuth() {
  $('auth-modal').classList.add('hidden');
}
function setAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.authtab === tab));
  $('form-login').classList.toggle('hidden', tab !== 'login');
  $('form-signup').classList.toggle('hidden', tab !== 'signup');
}

document.querySelectorAll('.auth-tab').forEach((b) =>
  b.addEventListener('click', () => setAuthTab(b.dataset.authtab)));
$('nav-login').addEventListener('click', () => openAuth('login'));
$('nav-signup').addEventListener('click', () => openAuth('signup'));
$('auth-close').addEventListener('click', closeAuth);
$('auth-modal').addEventListener('click', (e) => {
  if (e.target === $('auth-modal')) closeAuth();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAuth();
});

function authFail(boxId, btnId, msg, label) {
  const box = $(boxId);
  box.textContent = msg;
  box.classList.remove('hidden');
  const btn = $(btnId);
  btn.disabled = false;
  btn.textContent = label;
}

$('form-signup').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = $('signup-btn');
  btn.disabled = true;
  btn.textContent = 'Creating account…';
  $('signup-error').classList.add('hidden');
  setTimeout(() => {
    const res = signup($('signup-name').value, $('signup-email').value, $('signup-pass').value);
    if (!res.ok) {
      authFail('signup-error', 'signup-btn', res.error, 'Create free account →');
      return;
    }
    window.location.href = 'app.html';
  }, 350);
});

$('form-login').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = $('login-btn');
  btn.disabled = true;
  btn.textContent = 'Logging in…';
  $('login-error').classList.add('hidden');
  setTimeout(() => {
    const res = login($('login-email').value, $('login-pass').value);
    if (!res.ok) {
      authFail('login-error', 'login-btn', res.error, 'Log in →');
      return;
    }
    window.location.href = 'app.html';
  }, 350);
});

$('auth-guest').addEventListener('click', () => {
  ensureGuestSession();
  window.location.href = 'app.html';
});

/* ---------------- demo + payments ---------------- */
function launchDemo() {
  ensureGuestSession();
  window.location.href = 'app.html';
}

$('hero-demo').addEventListener('click', launchDemo);
$('pricing-demo').addEventListener('click', launchDemo);
$('final-demo').addEventListener('click', launchDemo);

function unlockFlow() {
  ensureGuestSession();
  const user = getCurrentUser();
  openPayModal({
    email: user ? user.email : '',
    title: 'Subscribe for Full Access',
    subtitle: 'Monthly subscription for SITE MATRIX 3D Studio — ' + fmtNGN(PRICE_NGN) + '/month. Renews monthly, cancel anytime.',
    successLabel: 'Open Studio →',
    successHref: 'app.html',
    onSuccess: () => renderNav()
  });
}

$('hero-unlock').addEventListener('click', unlockFlow);
$('pricing-unlock').addEventListener('click', unlockFlow);
$('final-unlock').addEventListener('click', unlockFlow);

renderNav();
