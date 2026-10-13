/* =====================================================================
   SITE MATRIX 3D — structural layout wiring (v2.2)
   Hamburger menu (navigation + delegates) + collapsible floating
   docks + movable taskbar. Pure DOM logic — app.js is untouched.
   ===================================================================== */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  /* ---------------- hamburger menu ---------------- */
  var menu = $('app-menu');
  var menuBtn = $('btn-menu');
  var menuNewProject = $('btn-menu-new-project');
  var menuLogout = $('btn-menu-logout');

  function isMenuOpen() {
    return !!menu && !menu.classList.contains('hidden');
  }

  function closeMenu() {
    if (!menu) return;
    menu.classList.add('hidden');
    if (menuBtn) menuBtn.classList.remove('active');
  }

  // dynamic labels: PRO/DEMO lock on New Project, Logout/Exit wording
  function refreshMenuLabels() {
    if (menuNewProject) {
      var activateBtn = $('btn-activate');
      var locked = !!activateBtn && !activateBtn.classList.contains('hidden');
      menuNewProject.textContent = locked ? '➕ New Project 🔒' : '➕ New Project';
    }
    if (menuLogout) {
      var realLogout = $('btn-logout');
      menuLogout.textContent = realLogout ? realLogout.textContent : '⏻ Log out / Exit';
    }
  }

  if (menu && menuBtn) {
    menuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = menu.classList.contains('hidden');
      menu.classList.toggle('hidden');
      menuBtn.classList.toggle('active', willOpen);
      if (willOpen) refreshMenuLabels();
    });
    // choosing any action closes the menu (editor handlers still run)
    menu.querySelectorAll('button, a').forEach(function (b) {
      b.addEventListener('click', closeMenu);
    });
    // click outside closes
    document.addEventListener('click', function (e) {
      if (isMenuOpen() && !menu.contains(e.target) && !menuBtn.contains(e.target)) {
        closeMenu();
      }
    });
    // Esc closes (the editor also deselects — both are harmless together)
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu();
    });
  }

  /* ---- menu shortcuts that delegate to dock buttons ----
     (works even when the docks are collapsed or on another tab) */
  function delegateClick(srcId, targetId) {
    var src = $(srcId);
    var target = $(targetId);
    if (src && target) {
      src.addEventListener('click', function () { target.click(); });
    }
  }
  delegateClick('btn-menu-new-project', 'btn-new-project');
  delegateClick('btn-menu-logout', 'btn-logout');

  /* ---------------- Alt+drag duplicate hint ---------------- */
  (function altHint() {
    var hint = $('alt-duplicate-hint');
    if (!hint) return;
    function sync(e) {
      hint.classList.toggle('hidden', !e.altKey);
    }
    document.addEventListener('keydown', sync);
    document.addEventListener('keyup', sync);
    document.addEventListener('mousemove', function (e) {
      if (e.altKey || !e.buttons) sync(e);
    });
    window.addEventListener('blur', function () { hint.classList.add('hidden'); });
  })();

  /* ---------------- collapsible docks ---------------- */
  var DOCK_KEY = 'sitematrix3d.docks';

  function readDocks() {
    try { return JSON.parse(localStorage.getItem(DOCK_KEY)) || {}; }
    catch (e) { return {}; }
  }

  function writeDocks(state) {
    try { localStorage.setItem(DOCK_KEY, JSON.stringify(state)); }
    catch (e) { /* storage unavailable — ignore */ }
  }

  function setDock(side, collapsed) {
    document.body.classList.toggle('dock-' + side + '-collapsed', !!collapsed);
    var state = readDocks();
    state[side] = !!collapsed;
    writeDocks(state);
  }

  function wireDock(side) {
    var collapseBtn = $('dock-collapse-' + side);
    var expandTab = $('dock-expand-' + side);
    if (collapseBtn) {
      collapseBtn.addEventListener('click', function () { setDock(side, true); });
    }
    if (expandTab) {
      expandTab.addEventListener('click', function () { setDock(side, false); });
    }
  }

  wireDock('left');
  wireDock('right');

  /* ---------------- movable bottom taskbar ----------------
     Drag the ⋮⋮ grip to slide the command dock sideways.
     Position is stored as a fraction of the stage width, clamped
     so the dock never leaves the workspace. Double-click re-centers. */
  var dock = $('command-dock');
  var grip = $('dock-grip');
  var stage = $('viewport-wrap');
  var DOCKPOS_KEY = 'sitematrix3d.dockpos';

  function dockFraction() {
    try {
      var v = parseFloat(localStorage.getItem(DOCKPOS_KEY));
      if (isFinite(v)) return Math.min(0.98, Math.max(0.02, v));
    } catch (e) { /* ignore */ }
    return 0.5;
  }

  function saveDockFraction(f) {
    try { localStorage.setItem(DOCKPOS_KEY, String(f)); }
    catch (e) { /* ignore */ }
  }

  function placeDock(frac) {
    if (!dock || !stage) return 0.5;
    frac = Math.min(0.98, Math.max(0.02, isFinite(frac) ? frac : 0.5));
    var W = stage.clientWidth;
    var dw = dock.offsetWidth;
    if (W <= 0) return frac;
    if (dw + 16 >= W) { dock.style.left = '50%'; return 0.5; }
    var half = dw / 2 + 8;
    var cx = Math.min(W - half, Math.max(half, frac * W));
    dock.style.left = cx + 'px';
    return cx / W;
  }

  if (dock && grip && stage) {
    requestAnimationFrame(function () { placeDock(dockFraction()); });
    window.addEventListener('resize', function () { placeDock(dockFraction()); });

    var dragging = false;
    var startX = 0;
    var startFrac = 0.5;
    var moved = false;

    grip.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== undefined && e.button !== 0) return;
      dragging = true;
      moved = false;
      startX = e.clientX;
      var wr = stage.getBoundingClientRect();
      var dr = dock.getBoundingClientRect();
      startFrac = wr.width > 0 ? (dr.left + dr.width / 2 - wr.left) / wr.width : 0.5;
      dock.classList.add('dragging');
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    });

    grip.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var wr = stage.getBoundingClientRect();
      if (wr.width <= 0) return;
      if (Math.abs(e.clientX - startX) > 3) moved = true;
      placeDock(startFrac + (e.clientX - startX) / wr.width);
    });

    function endDockDrag() {
      if (!dragging) return;
      dragging = false;
      dock.classList.remove('dragging');
      var wr = stage.getBoundingClientRect();
      var dr = dock.getBoundingClientRect();
      if (wr.width > 0) {
        saveDockFraction((dr.left + dr.width / 2 - wr.left) / wr.width);
      }
    }

    grip.addEventListener('pointerup', endDockDrag);
    grip.addEventListener('pointercancel', endDockDrag);

    grip.addEventListener('dblclick', function () {
      placeDock(0.5);
      saveDockFraction(0.5);
    });

    // swallow the click that follows a real drag
    grip.addEventListener('click', function (e) {
      if (moved) {
        e.stopPropagation();
        e.preventDefault();
        moved = false;
      }
    }, true);
  }
})();
