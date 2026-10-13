/* =====================================================================
   SITE MATRIX 3D STUDIO — 3D building / blueprint designer
   with Holographic Studio (Solid / Exploded / Volumetric),
   live XYZ scan HUD, projects library, demo + ₦2,000 PRO activation.
   ===================================================================== */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import {
  getSession, getCurrentUser, getOwner, isActivated, logout,
  getProjects, saveProjects, createProject, touchProject, deleteProject,
  getCurrentProjectId, setCurrentProjectId, openPayModal, fmtDate, isOwner, getSubscription
} from './common.js?v=3';

// ---- session guard: must enter via landing (login/signup) or demo mode ----
{
  const _sess = getSession();
  if (!_sess || (!_sess.guest && !getCurrentUser())) {
    try { localStorage.removeItem('sitematrix3d.session'); } catch (e) { /* ignore */ }
    window.location.replace('index.html');
  }
}

/* ---------------- state ---------------- */
let scene, camera, renderer, orbit, tc;
let ground, groundMat, grid;
let hemi, dirLight;
let raycaster, pointer;

let objects = [];          // selectable root objects in the scene
let selected = null;
let selectionHelper = null;
let tool = 'select';       // select | translate | rotate | scale
let mode = 'blueprint';    // blueprint | realistic | dark
let snapEnabled = true;
let snapSize = 0.5;

let uid = 1;
const typeCounters = {};

const undoStack = [];
const redoStack = [];
const MAX_HIST = 60;
let dragSnapshot = null;
let propSnapshot = null;
let autosaveTimer = null;

// sessions / projects / license
let owner = 'guest';
let ACTIVATED = false;
let currentProjectId = null;

// holographic studio
let holoStyle = 'real';    // real | solid | exploded | volumetric
let explodeFactor = 1.2;
let explodeCentroid = new THREE.Vector3();
let spinBeforeHolo = false;
let holoRig = null, holoScan = null, holoAxes = null;
let holoRing1 = null, holoRing2 = null, holoDisc = null;
let holoDot1 = null, holoDot2 = null;
const rigBounds = {
  min: new THREE.Vector3(), max: new THREE.Vector3(),
  center: new THREE.Vector3(), size: new THREE.Vector3(1, 1, 1), radius: 3
};
const HOLO = {};

/* ---------------- display modes ---------------- */
const MODES = {
  blueprint: { bg: 0x0d2b52, ground: 0x12305c, gridCenter: 0xffffff, grid: 0x2f5d9e, fog: [48, 120], hemi: 0.9,  dir: 1.15, edge: 0xffffff, edgeOpacity: 0.35 },
  realistic: { bg: 0xdfe7ef, ground: 0xc7d1dd, gridCenter: 0x71809a, grid: 0xa6b3c4, fog: [55, 130], hemi: 1.05, dir: 1.4,  edge: 0x1c2733, edgeOpacity: 0.20 },
  dark:      { bg: 0x0e1116, ground: 0x151a21, gridCenter: 0x4b5a70, grid: 0x232c38, fog: [48, 120], hemi: 0.7,  dir: 1.0,  edge: 0x8b98ad, edgeOpacity: 0.35 }
};

const SWATCHES = ['#f0ebe0', '#d8c9a3', '#a8442f', '#7a4a21', '#3f6b4f', '#2f5d9e', '#9fd4ff', '#f5c542', '#8d8d8d', '#22262b'];

/* =====================================================================
   BLOCK FACTORY
   ===================================================================== */

function stdMat(color, opts = {}) {
  const { tintable = true, ...rest } = opts;
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, ...rest });
  m.userData.tintable = tintable;
  return m;
}

function boxMesh(w, h, d, color, opts) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), stdMat(color, opts));
}
function cylMesh(rt, rb, h, color, opts, seg = 20) {
  return new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), stdMat(color, opts));
}

function finalize(obj, type, name, color) {
  obj.userData.isSelectable = true;
  obj.userData.id = 'obj-' + (uid++);
  obj.userData.type = type;
  obj.userData.name = name;
  obj.userData.color = color;
  obj.userData.locked = false;
  obj.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
  return obj;
}

function nextName(type) {
  const def = BLOCK_DEFS[type];
  typeCounters[type] = (typeCounters[type] || 0) + 1;
  return def.label + ' ' + typeCounters[type];
}

function gableRoofGeometry(w, h, l) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(0, h);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: l, bevelEnabled: false });
  geo.translate(0, 0, -l / 2);
  geo.rotateY(Math.PI / 2); // footprint: X = l, Z = w
  return geo;
}

const BLOCK_DEFS = {
  custom:     { label: 'Custom Block', color: '#c9b48a', make(n, dims) { return makeCustomBlock(n, dims); } },
  wall:       { label: 'Wall',         color: '#f0ebe0', make(n) { return finalize(boxMesh(4, 2.6, 0.2, '#f0ebe0'), 'wall', n, '#f0ebe0'); } },
  wallLong:   { label: 'Long Wall',    color: '#f0ebe0', make(n) { return finalize(boxMesh(6, 2.6, 0.2, '#f0ebe0'), 'wallLong', n, '#f0ebe0'); } },
  floor:      { label: 'Floor',        color: '#d8c9a3', make(n) { return finalize(boxMesh(4, 0.2, 4, '#d8c9a3'), 'floor', n, '#d8c9a3'); } },
  floorLarge: { label: 'Big Slab',     color: '#d8c9a3', make(n) { return finalize(boxMesh(8, 0.2, 6, '#d8c9a3'), 'floorLarge', n, '#d8c9a3'); } },
  cube:       { label: 'Cube',         color: '#9fb6cc', make(n) { return finalize(boxMesh(1, 1, 1, '#9fb6cc'), 'cube', n, '#9fb6cc'); } },
  roofFlat:   { label: 'Flat Roof',    color: '#8d8d8d', make(n) { return finalize(boxMesh(5, 0.25, 5, '#8d8d8d'), 'roofFlat', n, '#8d8d8d'); } },

  column: { label: 'Column', color: '#e6e1d5', make(n) {
    const g = new THREE.Group();
    const base = boxMesh(0.55, 0.15, 0.55, '#cfc9ba'); base.position.y = 0.075;
    const shaft = cylMesh(0.15, 0.18, 2.6, '#e6e1d5'); shaft.position.y = 0.15 + 1.3;
    const cap = boxMesh(0.5, 0.12, 0.5, '#cfc9ba'); cap.position.y = 0.15 + 2.6 + 0.06;
    g.add(base, shaft, cap);
    return finalize(g, 'column', n, '#e6e1d5');
  } },

  roofGable: { label: 'Gable Roof', color: '#a8442f', make(n) {
    const m = new THREE.Mesh(gableRoofGeometry(5, 2, 6), stdMat('#a8442f', { flatShading: true }));
    return finalize(m, 'roofGable', n, '#a8442f');
  } },

  roofPyramid: { label: 'Pyramid Roof', color: '#a8442f', make(n) {
    const geo = new THREE.ConeGeometry(5 / Math.SQRT2, 2, 4);
    geo.rotateY(Math.PI / 4);
    geo.translate(0, 1, 0); // origin at base
    const m = new THREE.Mesh(geo, stdMat('#a8442f', { flatShading: true }));
    return finalize(m, 'roofPyramid', n, '#a8442f');
  } },

  door: { label: 'Door', color: '#7a4a21', make(n) {
    const g = new THREE.Group();
    const frame = boxMesh(1.14, 2.24, 0.12, '#e8e4da', { tintable: false }); frame.position.y = 1.12;
    const panel = boxMesh(0.92, 2.02, 0.07, '#7a4a21'); panel.position.set(0, 1.03, 0.02);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 12), stdMat('#f5c542', { tintable: false, metalness: 0.7, roughness: 0.3 }));
    knob.position.set(0.32, 1.05, 0.08);
    g.add(frame, panel, knob);
    return finalize(g, 'door', n, '#7a4a21');
  } },

  window: { label: 'Window', color: '#f5f5f5', make(n) {
    const g = new THREE.Group();
    const frame = boxMesh(1.5, 1.2, 0.14, '#f5f5f5');
    const glass = boxMesh(1.3, 1.0, 0.16, '#9fd4ff', { tintable: false, transparent: true, opacity: 0.55, roughness: 0.1, metalness: 0.3 });
    const mullV = boxMesh(0.07, 1.0, 0.17, '#f5f5f5'); mullV.position.z = 0.005;
    const mullH = boxMesh(1.3, 0.07, 0.17, '#f5f5f5'); mullH.position.z = 0.005;
    g.add(frame, glass, mullV, mullH);
    const out = finalize(g, 'window', n, '#f5f5f5');
    glass.castShadow = false;
    return out;
  } },

  stairs: { label: 'Stairs', color: '#c9bfae', make(n) {
    const g = new THREE.Group();
    const nSteps = 5, w = 2, sh = 0.2, sd = 0.28;
    for (let i = 0; i < nSteps; i++) {
      const h = sh * (i + 1);
      const step = boxMesh(w, h, sd, '#c9bfae');
      step.position.set(0, h / 2, ((nSteps - 1) / 2 - i) * sd);
      g.add(step);
    }
    return finalize(g, 'stairs', n, '#c9bfae');
  } },

  fence: { label: 'Fence', color: '#a9805a', make(n) {
    const g = new THREE.Group();
    const panel = boxMesh(2, 0.7, 0.06, '#a9805a'); panel.position.y = 0.55;
    const rail = boxMesh(2, 0.08, 0.09, '#a9805a'); rail.position.y = 0.92;
    const p1 = cylMesh(0.05, 0.05, 1.0, '#8a6a45', {}, 10); p1.position.set(-0.95, 0.5, 0);
    const p2 = p1.clone(); p2.position.x = 0.95;
    g.add(panel, rail, p1, p2);
    return finalize(g, 'fence', n, '#a9805a');
  } },

  tree: { label: 'Tree', color: '#3f6b4f', make(n) {
    const g = new THREE.Group();
    const trunk = cylMesh(0.09, 0.14, 1.2, '#6b4a2b', { tintable: false }); trunk.position.y = 0.6;
    const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(1.1, 1), stdMat('#3f6b4f', { flatShading: true }));
    leaves.position.y = 2.0;
    g.add(trunk, leaves);
    return finalize(g, 'tree', n, '#3f6b4f');
  } },

  human: { label: 'Person', color: '#5b7fa6', make(n) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.95, 6, 14), stdMat('#5b7fa6'));
    body.position.y = 0.82;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 16), stdMat('#e8b88a', { tintable: false }));
    head.position.y = 1.52;
    g.add(body, head);
    return finalize(g, 'human', n, '#5b7fa6');
  } }
};

/* =====================================================================
   INIT
   ===================================================================== */

function init() {
  const container = document.getElementById('viewport');

  scene = new THREE.Scene();
  scene.background = new THREE.Color(MODES[mode].bg);
  scene.fog = new THREE.Fog(MODES[mode].bg, 48, 120);

  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
  camera.position.set(11, 8.5, 11);

  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  hemi = new THREE.HemisphereLight(0xffffff, 0x33415c, MODES[mode].hemi);
  scene.add(hemi);
  dirLight = new THREE.DirectionalLight(0xffffff, MODES[mode].dir);
  dirLight.position.set(12, 18, 8);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(2048, 2048);
  dirLight.shadow.camera.left = -22; dirLight.shadow.camera.right = 22;
  dirLight.shadow.camera.top = 22; dirLight.shadow.camera.bottom = -22;
  dirLight.shadow.camera.near = 1; dirLight.shadow.camera.far = 60;
  dirLight.shadow.bias = -0.0004;
  scene.add(dirLight);

  groundMat = new THREE.MeshStandardMaterial({ color: MODES[mode].ground, roughness: 1, metalness: 0 });
  ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  rebuildGrid();

  orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.target.set(0, 1, 0);
  orbit.maxPolarAngle = Math.PI * 0.495;
  orbit.minDistance = 2.5;
  orbit.maxDistance = 80;
  orbit.autoRotateSpeed = 1.1;

  tc = new TransformControls(camera, renderer.domElement);
  tc.setSize(0.9);
  tc.setSpace('world');
  scene.add(tc);
  applySnap();

  tc.addEventListener('dragging-changed', (e) => {
    orbit.enabled = !e.value;
    if (e.value) {
      dragSnapshot = serializeScene();
      if (altHeld && selected && !selected.userData.locked) {
        const _cd = serializeObject(selected);
        _cd.name = nextName(_cd.type);
        const _clone = createFromData(_cd);
        if (_clone) {
          select(_clone);
          tc.attach(_clone);
          toast('⧉ Dragging out a copy — release to place it');
        }
      }
    } else {
      if (dragSnapshot) {
        undoStack.push(dragSnapshot);
        if (undoStack.length > MAX_HIST) undoStack.shift();
        redoStack.length = 0;
        dragSnapshot = null;
        updateUndoRedo();
      }
      syncPropNumbers();
      onSceneChanged();
    }
  });
  tc.addEventListener('objectChange', () => {
    syncPropNumbers();
    updateSpinRing();
    if (holoStyle !== 'real') { fitHoloRig(); updateHUD(); }
  });

  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();

  owner = getOwner();
  ACTIVATED = isActivated();
  buildHoloRig();
  renderSessionUI();
  bindUI();
  buildSwatches();
  onResize();
  new ResizeObserver(onResize).observe(container);
  window.addEventListener('resize', onResize);

  bootProjects();

  window.addEventListener('beforeunload', () => writeAutosave());
  animate();
}

function onResize() {
  const container = document.getElementById('viewport');
  const w = container.clientWidth || 2, h = container.clientHeight || 2;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function animate() {
  requestAnimationFrame(animate);
  orbit.update();
  if (selectionHelper && selected) {
    try { selectionHelper.update(); } catch (e) { /* object may be mid-change */ }
  }
  tickHolo();
  tickSpinRing();
  renderer.render(scene, camera);
}

/* =====================================================================
   GRID / DISPLAY MODES
   ===================================================================== */

function rebuildGrid() {
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    grid.material.dispose();
  }
  const c = MODES[mode];
  grid = new THREE.GridHelper(60, 60, c.gridCenter, c.grid);
  grid.position.y = 0.02;
  const cb = document.getElementById('grid-visible');
  grid.visible = cb ? cb.checked : true;
  scene.add(grid);
}

function setDisplayMode(m) {
  if (!MODES[m]) return;
  mode = m;
  const c = MODES[m];
  scene.background.set(c.bg);
  scene.fog = new THREE.Fog(c.bg, c.fog[0], c.fog[1]);
  groundMat.color.set(c.ground);
  hemi.intensity = c.hemi;
  dirLight.intensity = c.dir;
  rebuildGrid();
  if (holoStyle === 'real') updateEdgeColors();
  document.querySelectorAll('#mode-group .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === m));
  document.getElementById('viewport-wrap').style.background = '#' + new THREE.Color(c.bg).getHexString();
  updateStatus();
}

function setView(v) {
  const views = {
    '3d':    { p: [11, 8.5, 11], t: [0, 1, 0] },
    top:     { p: [0.01, 23, 0.01], t: [0, 0, 0] },
    front:   { p: [0, 3.5, 15],  t: [0, 2, 0] },
    side:    { p: [15, 3.5, 0],  t: [0, 2, 0] }
  };
  const vw = views[v];
  if (!vw) return;
  camera.position.set(...vw.p);
  orbit.target.set(...vw.t);
  orbit.update();
  document.querySelectorAll('#view-group .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === v));
}

/* =====================================================================
   EDGES (blueprint outlines)
   ===================================================================== */

function addEdgesToObject(obj) {
  const c = MODES[mode];
  obj.traverse((ch) => {
    if (ch.isMesh && !ch.userData.hasEdges) {
      ch.userData.hasEdges = true;
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(ch.geometry, 30),
        new THREE.LineBasicMaterial({ color: c.edge, transparent: true, opacity: c.edgeOpacity })
      );
      edges.userData.isEdge = true;
      edges.raycast = () => {};
      ch.add(edges);
    }
  });
}

function updateEdgeColors() {
  const c = MODES[mode];
  for (const o of objects) {
    o.traverse((ch) => {
      if (ch.userData && ch.userData.isEdge) {
        ch.material.color.set(c.edge);
        ch.material.opacity = c.edgeOpacity;
      }
    });
  }
}

/* =====================================================================
   SELECTION
   ===================================================================== */

function select(obj) {
  if (!obj || selected === obj) return;
  deselect();
  selected = obj;
  selectionHelper = new THREE.BoxHelper(obj, holoStyle === 'real' ? 0x00e5ff : 0xff5df2);
  selectionHelper.visible = obj.visible;
  scene.add(selectionHelper);
  if (tool !== 'select' && !obj.userData.locked) tc.attach(obj);
  if (obj.userData.locked) toast('🔒 This object is locked — unlock it in Properties to move it');
  updateSpinRing();
  renderPropsPanel();
  updateOutliner();
  updateStatus();
}

function deselect() {
  if (tc.object) tc.detach();
  if (selectionHelper) {
    scene.remove(selectionHelper);
    selectionHelper.geometry.dispose();
    selectionHelper.material.dispose();
    selectionHelper = null;
  }
  selected = null;
  hideSpinRing();
  renderPropsPanel();
  updateOutliner();
  updateStatus();
}

function pick(e) {
  if (ringSuppressPick) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const candidates = objects.filter((o) => o.visible);
  const hits = raycaster.intersectObjects(candidates, true);
  if (hits.length > 0) {
    let o = hits[0].object;
    while (o.parent && o.parent !== scene) o = o.parent;
    select(o);
  } else {
    deselect();
  }
}

/* =====================================================================
   TOOLS / SNAP
   ===================================================================== */

function setTool(t) {
  tool = t;
  document.querySelectorAll('[data-tool]').forEach((b) =>
    b.classList.toggle('active', b.dataset.tool === t));
  if (t === 'select') {
    tc.detach();
  } else {
    tc.setMode(t);
    if (selected && !selected.userData.locked) tc.attach(selected);
    else tc.detach();
  }
  updateStatus();
  updateSpinRing();
}

function applySnap() {
  tc.setTranslationSnap(snapEnabled ? snapSize : null);
  tc.setRotationSnap(snapEnabled ? Math.PI / 12 : null);
  tc.setScaleSnap(snapEnabled ? 0.1 : null);
}

/* =====================================================================
   ADD / MODIFY OBJECTS
   ===================================================================== */

function applyColor(obj, hex) {
  obj.userData.color = hex;
  obj.traverse((c) => {
    if (c.isMesh) {
      // tint the ORIGINAL material (it may be stashed while in holo mode)
      const mats = [];
      if (c.userData._origMat) {
        const om = c.userData._origMat;
        (Array.isArray(om) ? om : [om]).forEach((m) => mats.push(m));
      } else {
        (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => mats.push(m));
      }
      mats.forEach((m) => {
        if (m && !(m.userData && m.userData.sharedHolo) && m.userData.tintable !== false && m.color) {
          m.color.set(hex);
        }
      });
    }
  });
}

function dropToGround(obj, baseY = 0) {
  const box = new THREE.Box3().setFromObject(obj);
  obj.position.y += (baseY - box.min.y);
}

function addBlock(type, opts = {}) {
  const def = BLOCK_DEFS[type];
  if (!def) return;
  pushHistory();
  const obj = (type === 'custom' && opts.dims) ? makeCustomBlock(nextName(type), opts.dims) : def.make(nextName(type));
  if (opts.color) applyColor(obj, opts.color);
  addEdgesToObject(obj);
  applyHoloToNewObject(obj);
  scene.add(obj);
  objects.push(obj);
  const jx = ((objects.length % 5) * 0.7) - 1.4;
  const jz = ((objects.length % 3) * 0.7) - 0.7;
  obj.position.x += jx;
  obj.position.z += jz;
  if (holoStyle !== 'exploded') dropToGround(obj);
  if (opts.position) obj.position.set(...opts.position);
  if (opts.rotationY) obj.rotation.y = opts.rotationY;
  if (opts.scale) obj.scale.set(...opts.scale);
  select(obj);
  if (tool === 'select') setTool('translate');
  afterChange();
  toast('Added ' + obj.userData.name + ' — drag the arrows to move it');
}

function createFromData(d) {
  const def = BLOCK_DEFS[d.type];
  if (!def) return null;
  const obj = (d.type === 'custom' && Array.isArray(d.dims)) ? makeCustomBlock(d.name || nextName(d.type), d.dims) : def.make(d.name || nextName(d.type));
  if (d.position) obj.position.fromArray(d.position);
  if (d.rotation) obj.rotation.set(d.rotation[0], d.rotation[1], d.rotation[2]);
  if (d.scale) obj.scale.fromArray(d.scale);
  if (d.color) applyColor(obj, d.color);
  obj.visible = d.visible !== false;
  obj.userData.locked = !!d.locked;
  addEdgesToObject(obj);
  if (holoStyle !== 'real' && holoStyle !== 'exploded') applyHoloToNewObject(obj);
  // NOTE: in exploded mode, offsets are applied later by computeExplodeOffsets()
  // (called from restoreScene), so base positions stay clean.
  scene.add(obj);
  objects.push(obj);
  return obj;
}

function serializeObject(o) {
  // In exploded view, strip the visual offset so saves/history keep BASE positions.
  const p = o.position.clone();
  if (holoStyle === 'exploded' && o.userData._expDir) {
    p.addScaledVector(o.userData._expDir, -explodeFactor);
  }
  return {
    type: o.userData.type,
    name: o.userData.name,
    position: p.toArray(),
    rotation: [o.rotation.x, o.rotation.y, o.rotation.z],
    scale: o.scale.toArray(),
    color: o.userData.color,
    dims: o.userData.dims ? [...o.userData.dims] : undefined,
    visible: o.visible,
    locked: !!o.userData.locked
  };
}

function serializeScene() {
  return objects.map(serializeObject);
}

function disposeObject(o) {
  o.traverse((c) => {
    if (c.userData && c.userData.isHoloPoints) return; // shares geometry + material with parent
    if (c.geometry) c.geometry.dispose();
    if (c.material) {
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach((m) => { if (!(m.userData && m.userData.sharedHolo)) m.dispose(); });
    }
    if (c.userData && c.userData._origMat) {
      const om = c.userData._origMat;
      (Array.isArray(om) ? om : [om]).forEach((m) => {
        if (m && !(m.userData && m.userData.sharedHolo)) m.dispose();
      });
      c.userData._origMat = null;
    }
  });
}

function clearObjectsOnly() {
  for (const o of objects) {
    scene.remove(o);
    disposeObject(o);
  }
  objects.length = 0;
}

function restoreScene(data) {
  deselect();
  clearObjectsOnly();
  (data || []).forEach((d) => createFromData(d));
  if (holoStyle === 'exploded') {
    for (const o of objects) applyHoloMaterialToObject(o);
    computeExplodeOffsets();
  }
  if (holoStyle !== 'real') { fitHoloRig(); updateHUD(); }
  afterChange();
  renderPropsPanel();
}

function deleteSelected() {
  if (!selected) { toast('Select something first'); return; }
  pushHistory();
  const o = selected;
  const name = o.userData.name;
  deselect();
  scene.remove(o);
  objects.splice(objects.indexOf(o), 1);
  disposeObject(o);
  afterChange();
  toast('Deleted ' + name);
}

function duplicateSelected() {
  if (!selected) { toast('Select something first'); return; }
  pushHistory();
  const d = serializeObject(selected);
  d.name = nextName(d.type);
  const obj = createFromData(d);
  if (obj) {
    if (holoStyle === 'exploded') {
      const dir = explodeDirFor(obj, explodeCentroid);
      obj.userData._expDir = dir;
      obj.position.addScaledVector(dir, explodeFactor);
    }
    obj.position.x += 0.8;
    obj.position.z += 0.8;
    select(obj);
  }
  afterChange();
  toast('Duplicated as ' + d.name);
}

function focusSelected() {
  if (!selected) { toast('Select something first'); return; }
  const box = new THREE.Box3().setFromObject(selected);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const dist = Math.max(size.length() * 1.3, 4);
  const dir = camera.position.clone().sub(orbit.target);
  if (dir.lengthSq() < 0.001) dir.set(1, 0.7, 1);
  dir.normalize();
  orbit.target.copy(center);
  camera.position.copy(center).addScaledVector(dir, dist);
  orbit.update();
}

/* =====================================================================
   HISTORY (undo / redo)
   ===================================================================== */

let batchHistory = false;
function pushHistory() {
  if (batchHistory) return;
  undoStack.push(serializeScene());
  if (undoStack.length > MAX_HIST) undoStack.shift();
  redoStack.length = 0;
  updateUndoRedo();
}

function undo() {
  if (!undoStack.length) { toast('Nothing to undo'); return; }
  redoStack.push(serializeScene());
  restoreScene(undoStack.pop());
  updateUndoRedo();
  toast('↶ Undone');
}

function redo() {
  if (!redoStack.length) { toast('Nothing to redo'); return; }
  undoStack.push(serializeScene());
  restoreScene(redoStack.pop());
  updateUndoRedo();
  toast('↷ Redone');
}

function updateUndoRedo() {
  document.getElementById('btn-undo').disabled = undoStack.length === 0;
  document.getElementById('btn-redo').disabled = redoStack.length === 0;
}

/* =====================================================================
   PROPERTIES PANEL
   ===================================================================== */

const $ = (id) => document.getElementById(id);

function fmt(n) {
  return Math.round(n * 100) / 100;
}

function renderPropsPanel() {
  const empty = $('props-empty');
  const form = $('props-form');
  if (!selected) {
    empty.classList.remove('hidden');
    form.classList.add('hidden');
    updateHUD();
    return;
  }
  empty.classList.add('hidden');
  form.classList.remove('hidden');
  $('prop-name').value = selected.userData.name;
  $('prop-type').textContent = (BLOCK_DEFS[selected.userData.type] || {}).label || selected.userData.type;
  $('prop-color').value = selected.userData.color || '#ffffff';
  $('prop-visible').checked = selected.visible;
  $('prop-locked').checked = !!selected.userData.locked;
  document.querySelectorAll('#swatches .swatch').forEach((s) =>
    s.classList.toggle('active', s.dataset.color === selected.userData.color));
  syncPropNumbers();
  updateHUD();
}

/* ---- precise rotation dial (Inspector turntable) ---- */
let dialAxis = 'y';

function dialDeg() {
  if (!selected) return 0;
  const r = selected.rotation[dialAxis] || 0;
  return ((Math.round(THREE.MathUtils.radToDeg(r)) % 360) + 360) % 360;
}

function setDialRotation(deg) {
  if (!selected) return;
  const norm = ((deg % 360) + 360) % 360;
  selected.rotation[dialAxis] = THREE.MathUtils.degToRad(norm);
  syncPropNumbers();
  updateDims();
  if (holoStyle !== 'real') { fitHoloRig(); updateHUD(); }
}

function syncRotationDial() {
  const needle = $('rot-needle');
  if (!needle || !selected) return;
  const deg = dialDeg();
  needle.style.transform = 'rotate(' + deg + 'deg)';
  $('rot-deg').textContent = deg + '°';
  const slider = $('rot-slider');
  if (slider && document.activeElement !== slider) slider.value = deg;
}

function bindRotationDial() {
  const dial = $('rot-dial');
  if (!dial || dial.dataset.bound) return;
  dial.dataset.bound = '1';
  document.querySelectorAll('#rot-axis .rot-axis-btn').forEach((b) => {
    b.addEventListener('click', () => {
      dialAxis = b.dataset.axis;
      document.querySelectorAll('#rot-axis .rot-axis-btn').forEach((x) =>
        x.classList.toggle('active', x === b));
      syncRotationDial();
    });
  });
  const slider = $('rot-slider');
  slider.addEventListener('focus', () => { propSnapshot = serializeScene(); });
  slider.addEventListener('input', () => setDialRotation(parseFloat(slider.value) || 0));
  slider.addEventListener('change', commitPropSnapshot);
  document.querySelectorAll('.rot-presets button').forEach((b) => {
    b.addEventListener('click', () => {
      if (!selected) return;
      pushHistory();
      setDialRotation(parseFloat(b.dataset.deg) || 0);
      afterChange();
    });
  });
  // drag the dial in a circle for precise angles
  let dragging = false;
  const angleFromEvent = (e) => {
    const r = dial.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    return ((Math.round(Math.atan2(dx, -dy) * 180 / Math.PI) % 360) + 360) % 360;
  };
  dial.addEventListener('pointerdown', (e) => {
    if (!selected) return;
    dragging = true;
    propSnapshot = serializeScene();
    try { dial.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    setDialRotation(angleFromEvent(e));
  });
  dial.addEventListener('pointermove', (e) => {
    if (dragging) setDialRotation(angleFromEvent(e));
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    commitPropSnapshot();
  };
  dial.addEventListener('pointerup', endDrag);
  dial.addEventListener('pointercancel', endDrag);
}

function syncPropNumbers() {
  if (!selected) return;
  const ae = document.activeElement;
  const set = (id, v) => { const el = $(id); if (el && el !== ae) el.value = fmt(v); };
  set('pos-x', selected.position.x);
  set('pos-y', selected.position.y);
  set('pos-z', selected.position.z);
  set('rot-x', THREE.MathUtils.radToDeg(selected.rotation.x));
  set('rot-y', THREE.MathUtils.radToDeg(selected.rotation.y));
  set('rot-z', THREE.MathUtils.radToDeg(selected.rotation.z));
  set('scl-x', selected.scale.x);
  set('scl-y', selected.scale.y);
  set('scl-z', selected.scale.z);
  updateDims();
  syncRotationDial();
}

function updateDims() {
  if (!selected) return;
  try {
    const size = new THREE.Box3().setFromObject(selected).getSize(new THREE.Vector3());
    $('prop-dims').textContent = fmt(size.x) + ' × ' + fmt(size.y) + ' × ' + fmt(size.z) + ' m';
  } catch (e) { $('prop-dims').textContent = '–'; }
}

function applyPropNumbers() {
  if (!selected) return;
  const num = (id, fb) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : fb; };
  selected.position.set(num('pos-x', selected.position.x), num('pos-y', selected.position.y), num('pos-z', selected.position.z));
  selected.rotation.set(
    THREE.MathUtils.degToRad(num('rot-x', 0)),
    THREE.MathUtils.degToRad(num('rot-y', 0)),
    THREE.MathUtils.degToRad(num('rot-z', 0))
  );
  const cx = Math.max(0.05, num('scl-x', selected.scale.x));
  const cy = Math.max(0.05, num('scl-y', selected.scale.y));
  const cz = Math.max(0.05, num('scl-z', selected.scale.z));
  selected.scale.set(cx, cy, cz);
  updateDims();
}

function commitPropSnapshot() {
  if (propSnapshot) {
    undoStack.push(propSnapshot);
    if (undoStack.length > MAX_HIST) undoStack.shift();
    redoStack.length = 0;
    propSnapshot = null;
    updateUndoRedo();
  }
  afterChange();
}

function buildSwatches() {
  const wrap = $('swatches');
  wrap.innerHTML = '';
  SWATCHES.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.color = c;
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => {
      if (!selected) return;
      pushHistory();
      applyColor(selected, c);
      $('prop-color').value = c;
      document.querySelectorAll('#swatches .swatch').forEach((s) =>
        s.classList.toggle('active', s.dataset.color === c));
      afterChange();
    });
    wrap.appendChild(b);
  });
}

/* =====================================================================
   OUTLINER + STATUS
   ===================================================================== */

function updateOutliner() {
  const list = $('outliner-list');
  list.innerHTML = '';
  $('scene-count').textContent = objects.length;
  if (!objects.length) {
    const d = document.createElement('div');
    d.className = 'outline-empty';
    d.textContent = 'Scene is empty — add blocks from the library.';
    list.appendChild(d);
    return;
  }
  objects.forEach((o) => {
    const row = document.createElement('div');
    row.className = 'outline-item' + (o === selected ? ' selected' : '');
    const dot = document.createElement('span');
    dot.className = 'outline-dot';
    dot.style.background = o.userData.color || '#999';
    const name = document.createElement('span');
    name.className = 'outline-name';
    name.textContent = (o.userData.locked ? '🔒 ' : '') + o.userData.name;
    const type = document.createElement('span');
    type.className = 'outline-type';
    type.textContent = ((BLOCK_DEFS[o.userData.type] || {}).label) || '';
    const eye = document.createElement('button');
    eye.className = 'outline-eye';
    eye.textContent = o.visible ? '👁' : '🚫';
    eye.title = o.visible ? 'Hide' : 'Show';
    eye.addEventListener('click', (ev) => {
      ev.stopPropagation();
      pushHistory();
      o.visible = !o.visible;
      if (o === selected && selectionHelper) selectionHelper.visible = o.visible;
      if (o === selected) { if (!o.visible) tc.detach(); else if (tool !== 'select' && !o.userData.locked) tc.attach(o); }
      renderPropsPanel();
      afterChange();
    });
    row.addEventListener('click', () => select(o));
    row.append(dot, name, type, eye);
    list.appendChild(row);
  });
}

function updateStatus() {
  const toolNames = { select: 'Select', translate: 'Move', rotate: 'Rotate', scale: 'Scale' };
  const styleNames = { real: 'Real', solid: 'Holo·Solid', exploded: 'Holo·Exploded', volumetric: 'Holo·Volumetric' };
  const proj = getCurrentProject();
  const left = (proj ? '📁 ' + proj.name + '  •  ' : '') +
    objects.length + ' object' + (objects.length === 1 ? '' : 's') +
    ' • ' + (selected ? 'Selected: ' + selected.userData.name : 'Nothing selected') +
    ' • Tool: ' + (toolNames[tool] || tool);
  const right = mode.charAt(0).toUpperCase() + mode.slice(1) +
    ' • ' + (styleNames[holoStyle] || holoStyle) +
    (orbit && orbit.autoRotate ? ' • ⟳ spinning' : '') +
    ' • Snap ' + (snapEnabled ? snapSize + 'm ON' : 'OFF');
  $('status-left').textContent = left;
  $('status-right').textContent = right;
  const chip = $('current-project-name');
  if (chip) chip.textContent = proj ? proj.name : '—';
}

let emptyStateDismissed = false;

function updateEmptyState() {
  if (objects.length > 0) emptyStateDismissed = false; // re-arm once the user has blocks
  $('empty-state').classList.toggle('hidden', objects.length > 0 || emptyStateDismissed);
}

function onSceneChanged() {
  updateStatus();
  updateEmptyState();
  scheduleAutosave();
}

function afterChange() {
  updateOutliner();
  updateStatus();
  updateEmptyState();
  syncPropNumbers();
  updateSpinRing();
  if (holoStyle !== 'real') { fitHoloRig(); updateHUD(); }
  scheduleAutosave();
}

/* =====================================================================
   SAVE / LOAD / EXPORT / IMPORT / PNG
   ===================================================================== */

function saveManual() {
  saveCurrentProject(true);
}

function loadManual() {
  showLeftTab('projects');
  toast('📁 Your projects are listed here');
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(writeAutosave, 600);
}

function writeAutosave() {
  persistCurrentProject(false);
}

function readAutosave() {
  try {
    const raw = localStorage.getItem('sitematrix3d.autosave');
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function exportJSON() {
  if (!requireActivation('export your project as JSON')) return;
  const proj = getCurrentProject();
  const payload = {
    app: 'site-matrix-3d', version: 2,
    project: proj ? proj.name : 'untitled',
    savedAt: new Date().toISOString(), objects: serializeScene()
  };
  const safe = ((proj && proj.name) || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'project';
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'site-matrix-3d-' + safe + '.json');
  toast('📤 Project exported as JSON');
}

function importJSONFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(reader.result);
      const arr = Array.isArray(payload) ? payload : payload.objects;
      if (!arr || !Array.isArray(arr)) throw new Error('bad file');
      if (objects.length && !window.confirm('Import will replace the objects in the current project. Continue? (You can Undo.)')) return;
      pushHistory();
      restoreScene(arr);
      toast('📥 Imported ' + objects.length + ' objects');
    } catch (e) { toast('⚠️ Could not import — invalid project file'); }
  };
  reader.readAsText(file);
}

function exportPNG() {
  renderer.render(scene, camera);
  renderer.domElement.toBlob((blob) => {
    if (!blob) { toast('⚠️ Screenshot failed'); return; }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadBlob(blob, 'site-matrix-3d-' + stamp + '.png');
    toast('📷 Screenshot downloaded');
  }, 'image/png');
}

/* =====================================================================
   PROJECT ACTIONS + DEMO HOUSE
   ===================================================================== */

function newScene() {
  if (objects.length && !window.confirm('Clear all objects in this project? (You can Undo this.)')) return;
  pushHistory();
  deselect();
  clearObjectsOnly();
  afterChange();
  toast('🧹 Project cleared — add blocks from the library');
}

function place(type, x, y, z, opts = {}) {
  const def = BLOCK_DEFS[type];
  const obj = def.make(nextName(type));
  if (opts.color) applyColor(obj, opts.color);
  if (opts.scale) obj.scale.set(...opts.scale);
  if (opts.ry) obj.rotation.y = opts.ry;
  obj.position.set(x, y, z);
  addEdgesToObject(obj);
  applyHoloToNewObject(obj);
  scene.add(obj);
  objects.push(obj);
  return obj;
}

function demoBuild() {
  place('floorLarge', 0, 0.1, 0, { color: '#d8c9a3' });
  place('wallLong', 0, 1.5, 3, { color: '#f0ebe0', scale: [8 / 6, 1, 1] });
  place('wallLong', 0, 1.5, -3, { color: '#f0ebe0', scale: [8 / 6, 1, 1] });
  place('wallLong', -4, 1.5, 0, { ry: Math.PI / 2, color: '#e9e2d4' });
  place('wallLong', 4, 1.5, 0, { ry: Math.PI / 2, color: '#e9e2d4' });
  place('roofGable', 0, 2.8, 0, { color: '#a8442f', scale: [1.467, 1.1, 1.36] });
  place('cube', 2.5, 4.0, 0, { color: '#8d8d8d', scale: [0.7, 2.6, 0.7] });
  place('door', 0, 0.2, 3.12, { color: '#7a4a21' });
  place('window', -2.2, 1.7, 3.11, { color: '#ffffff' });
  place('window', 2.2, 1.7, 3.11, { color: '#ffffff' });
  place('window', -2, 1.7, -3.11, { ry: Math.PI, color: '#ffffff' });
  place('window', 2, 1.7, -3.11, { ry: Math.PI, color: '#ffffff' });
  place('window', -4.11, 1.7, 0, { ry: -Math.PI / 2, color: '#ffffff' });
  place('window', 4.11, 1.7, 0, { ry: Math.PI / 2, color: '#ffffff' });
  place('floor', 0, 0.075, 4.1, { color: '#c9bfae', scale: [0.8, 0.75, 0.6] });
  place('fence', -3, 0, 6, { color: '#a9805a' });
  place('fence', -1, 0, 6, { color: '#a9805a' });
  place('fence', 1, 0, 6, { color: '#a9805a' });
  place('fence', 3, 0, 6, { color: '#a9805a' });
  place('tree', -6.5, 0, -3.5, {});
  place('tree', 6.5, 0, -2.5, {});
  place('tree', -6, 0, 3, {});
  place('tree', 6.2, 0, 5, {});
  place('human', 2.8, 0, 4.6, {});
}

function loadDemoHouse() {
  if (objects.length && !window.confirm('Load the demo house? Your current scene will be replaced (you can Undo).')) return;
  pushHistory();
  deselect();
  clearObjectsOnly();
  demoBuild();
  if (holoStyle === 'exploded') computeExplodeOffsets();
  setView('3d');
  afterChange();
  toast('🏠 Demo house loaded — click any part to move it!');
}

/* =====================================================================
   UI WIRING
   ===================================================================== */

function toast(msg) {
  if (window.__sm3dBatch) return;
  const wrap = $('toast-container');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  wrap.appendChild(el);
  while (wrap.children.length > 3) wrap.firstChild.remove();
  setTimeout(() => el.classList.add('fade'), 2200);
  setTimeout(() => el.remove(), 2700);
}

function openHelp() { $('help-modal').classList.remove('hidden'); }
function closeHelp() { $('help-modal').classList.add('hidden'); }

function nudge(dx, dy, dz, isRepeat) {
  if (!selected) return;
  if (selected.userData.locked) { toast('🔒 Object is locked'); return; }
  if (!isRepeat) pushHistory();
  selected.position.x += dx;
  selected.position.y += dy;
  selected.position.z += dz;
  syncPropNumbers();
  onSceneChanged();
}

function bindUI() {
  document.querySelectorAll('#library [data-type]').forEach((b) =>
    b.addEventListener('click', () => addBlock(b.dataset.type)));

  document.querySelectorAll('[data-tool]').forEach((b) =>
    b.addEventListener('click', () => setTool(b.dataset.tool)));

  $('snap-enabled').addEventListener('change', (e) => {
    snapEnabled = e.target.checked;
    applySnap();
    updateStatus();
  });
  $('snap-size').addEventListener('change', (e) => {
    snapSize = parseFloat(e.target.value);
    applySnap();
    updateStatus();
  });
  $('grid-visible').addEventListener('change', (e) => { grid.visible = e.target.checked; });

  document.querySelectorAll('#view-group [data-view]').forEach((b) =>
    b.addEventListener('click', () => setView(b.dataset.view)));
  document.querySelectorAll('#mode-group [data-mode]').forEach((b) =>
    b.addEventListener('click', () => setDisplayMode(b.dataset.mode)));

  $('btn-new').addEventListener('click', newScene);
  $('btn-demo').addEventListener('click', loadDemoHouse);
  $('btn-undo').addEventListener('click', undo);
  $('btn-redo').addEventListener('click', redo);
  $('btn-save').addEventListener('click', saveManual);
  $('btn-load').addEventListener('click', loadManual);
  $('btn-export').addEventListener('click', exportJSON);
  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-import').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) importJSONFile(e.target.files[0]);
    e.target.value = '';
  });
  $('btn-png').addEventListener('click', exportPNG);
  $('btn-help').addEventListener('click', openHelp);
  $('help-close').addEventListener('click', closeHelp);
  $('help-modal').addEventListener('click', (e) => { if (e.target === $('help-modal')) closeHelp(); });

  $('empty-add-wall').addEventListener('click', () => addBlock('wall'));
  $('empty-demo').addEventListener('click', loadDemoHouse);
  $('empty-plain').addEventListener('click', () => {
    emptyStateDismissed = true;
    updateEmptyState();
    toast('📐 Plain blueprint ready — add blocks from the library whenever you like.');
  });

  ['pos-x', 'pos-y', 'pos-z', 'rot-x', 'rot-y', 'rot-z', 'scl-x', 'scl-y', 'scl-z'].forEach((id) => {
    const el = $(id);
    el.addEventListener('focus', () => { propSnapshot = serializeScene(); });
    el.addEventListener('input', applyPropNumbers);
    el.addEventListener('change', commitPropSnapshot);
  });

  $('prop-name').addEventListener('focus', () => { propSnapshot = serializeScene(); });
  $('prop-name').addEventListener('change', (e) => {
    if (!selected) return;
    selected.userData.name = e.target.value.trim() || selected.userData.name;
    e.target.value = selected.userData.name;
    commitPropSnapshot();
    updateOutliner();
    updateStatus();
  });

  $('prop-color').addEventListener('focus', () => { propSnapshot = serializeScene(); });
  $('prop-color').addEventListener('input', (e) => {
    if (!selected) return;
    applyColor(selected, e.target.value);
    document.querySelectorAll('#swatches .swatch').forEach((s) =>
      s.classList.toggle('active', s.dataset.color === e.target.value));
  });
  $('prop-color').addEventListener('change', commitPropSnapshot);

  $('prop-visible').addEventListener('change', (e) => {
    if (!selected) return;
    pushHistory();
    selected.visible = e.target.checked;
    if (selectionHelper) selectionHelper.visible = selected.visible;
    if (!selected.visible) tc.detach();
    else if (tool !== 'select' && !selected.userData.locked) tc.attach(selected);
    afterChange();
  });
  $('prop-locked').addEventListener('change', (e) => {
    if (!selected) return;
    pushHistory();
    selected.userData.locked = e.target.checked;
    if (selected.userData.locked) tc.detach();
    else if (tool !== 'select') tc.attach(selected);
    afterChange();
  });

  $('btn-duplicate').addEventListener('click', duplicateSelected);
  $('btn-focus').addEventListener('click', focusSelected);
  $('btn-rot45').addEventListener('click', () => {
    if (!selected) return;
    pushHistory();
    selected.rotation.y += Math.PI / 4;
    afterChange();
  });
  $('btn-ground').addEventListener('click', () => {
    if (!selected) return;
    pushHistory();
    dropToGround(selected);
    afterChange();
    toast('⬇ Dropped to ground');
  });
  $('btn-reset-rot').addEventListener('click', () => {
    if (!selected) return;
    pushHistory();
    selected.rotation.set(0, 0, 0);
    afterChange();
  });
  $('btn-delete').addEventListener('click', deleteSelected);
  bindRotationDial();
  bindSpinRing();
  bindAltClone();
  bindCtxMenu();
  $('btn-clear-all').addEventListener('click', newScene);

  let downX = 0, downY = 0;
  renderer.domElement.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
    if (tc.dragging) return;
    pick(e);
  });
  renderer.domElement.addEventListener('dblclick', () => { if (selected) focusSelected(); });
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    if (e.key === 'Escape') { closeHelp(); if (!typing) deselect(); return; }
    if (typing) return;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (ctrl && k === 's') { e.preventDefault(); saveManual(); return; }
    if (ctrl && k === 'd') { e.preventDefault(); duplicateSelected(); return; }
    if (ctrl || e.altKey) return;
    if (k === 'v') setTool('select');
    else if (k === 'g' || k === 'w') setTool('translate');
    else if (k === 'r') setTool('rotate');
    else if (k === 'q') quickRotate(-1, e.repeat);
    else if (k === 'e') quickRotate(1, e.repeat);
    else if (k === 's') setTool('scale');
    else if (k === 'f') focusSelected();
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    else if (e.key.startsWith('Arrow') || e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      const step = snapEnabled ? snapSize : 0.1;
      if (e.key === 'ArrowLeft') nudge(-step, 0, 0, e.repeat);
      else if (e.key === 'ArrowRight') nudge(step, 0, 0, e.repeat);
      else if (e.key === 'ArrowUp') nudge(0, 0, -step, e.repeat);
      else if (e.key === 'ArrowDown') nudge(0, 0, step, e.repeat);
      else if (e.key === 'PageUp') nudge(0, step, 0, e.repeat);
      else if (e.key === 'PageDown') nudge(0, -step, 0, e.repeat);
    }
  });

  // ---- left tabs + projects ----
  document.querySelectorAll('[data-lefttab]').forEach((b) =>
    b.addEventListener('click', () => showLeftTab(b.dataset.lefttab)));
  $('project-chip').addEventListener('click', () => showLeftTab('projects'));
  $('btn-new-project').addEventListener('click', newProject);
  $('project-name').addEventListener('change', (e) => renameCurrentProject(e.target.value));
  $('btn-activate').addEventListener('click', () => requireActivation('create unlimited projects'));
  $('btn-activate-2').addEventListener('click', () => requireActivation('create unlimited projects'));
  $('btn-logout').addEventListener('click', () => {
    persistCurrentProject(true);
    logout();
    window.location.replace('index.html');
  });

  // ---- holographic render styles ----
  document.querySelectorAll('#style-group [data-style]').forEach((b) =>
    b.addEventListener('click', () => setRenderStyle(b.dataset.style)));
  $('btn-spin').addEventListener('click', toggleSpin);
  $('explode-range').addEventListener('input', (e) => setExplodeFactor(parseFloat(e.target.value)));
  syncSpinButton();

  updateUndoRedo();
}

/* =====================================================================
   SESSIONS / PROJECTS / LICENSE
   ===================================================================== */

function getCurrentProject() {
  const list = getProjects(owner);
  return list.find((p) => p.id === currentProjectId) || null;
}

function renderSessionUI() {
  const user = getCurrentUser();
  ACTIVATED = isActivated();
  const OWNER = isOwner();
  if (user) {
    $('user-name').textContent = user.name;
    $('user-email').textContent = user.email;
    $('user-avatar').textContent = (user.name || 'U').trim().charAt(0).toUpperCase();
    $('btn-logout').textContent = 'Logout';
  } else {
    $('user-name').textContent = 'Guest';
    $('user-email').textContent = 'Demo mode — not signed in';
    $('user-avatar').textContent = 'G';
    $('btn-logout').textContent = '⏻ Exit to site';
  }
  const badge = $('license-badge');
  const badge2 = $('license-badge-2');
  const SUB = getSubscription();
  if (ACTIVATED) {
    badge.textContent = OWNER ? '👑 OWNER' : '⚡ PRO';
    badge.className = 'license-badge pro';
    badge2.textContent = OWNER ? '👑 OWNER — FULL ACCESS' : ('⚡ PRO — ' + SUB.daysLeft + ' DAY' + (SUB.daysLeft === 1 ? '' : 'S') + ' LEFT');
    badge2.className = 'license-pill pro';
    $('btn-activate').classList.add('hidden');
    $('btn-activate-2').classList.add('hidden');
  } else {
    const expired = SUB.status === 'expired';
    badge.textContent = expired ? 'SUB EXPIRED' : 'DEMO MODE';
    badge.className = 'license-badge demo';
    badge2.textContent = expired ? 'SUBSCRIPTION EXPIRED — RENEW TO CONTINUE' : 'DEMO MODE — 1 PROJECT';
    badge2.className = 'license-pill demo';
    $('btn-activate').innerHTML = expired ? '🔓 <span class="tb-label">Renew ₦2,000/mo</span>' : '🔓 <span class="tb-label">Subscribe ₦2,000/mo</span>';
    $('btn-activate-2').textContent = expired ? '🔁 Renew — ₦2,000/mo' : '🔓 Subscribe — ₦2,000/mo';
    $('btn-activate').classList.remove('hidden');
    $('btn-activate-2').classList.remove('hidden');
  }
  $('btn-export').textContent = ACTIVATED ? '📤 Export' : '📤 Export 🔒';
  $('btn-new-project').textContent = ACTIVATED ? '＋ New Project' : '＋ New Project 🔒';
  updateStatus();
}

function requireActivation(what) {
  if (isActivated()) {
    ACTIVATED = true;
    renderSessionUI();
    return true;
  }
  const user = getCurrentUser();
  openPayModal({
    email: user ? user.email : '',
    title: 'Subscribe for Full Access',
    subtitle: 'Activate your studio to ' + what + ' — ₦2,000/month. Renews monthly, cancel anytime.',
    onSuccess: () => {
      ACTIVATED = true;
      renderSessionUI();
      renderProjects();
      toast('🎉 Subscribed — welcome to PRO! Your access is active for 30 days.');
    }
  });
  return false;
}

function showLeftTab(which) {
  // opening the Projects tab always reveals the left dock
  document.body.classList.remove('dock-left-collapsed');
  try {
    const _ds = JSON.parse(localStorage.getItem('sitematrix3d.docks') || '{}');
    _ds.left = false;
    localStorage.setItem('sitematrix3d.docks', JSON.stringify(_ds));
  } catch (e) { /* ignore */ }
  document.querySelectorAll('[data-lefttab]').forEach((b) =>
    b.classList.toggle('active', b.dataset.lefttab === which));
  $('tab-build').classList.toggle('hidden', which !== 'build');
  $('tab-projects').classList.toggle('hidden', which !== 'projects');
  if (which === 'projects') renderProjects();
}

function bootProjects() {
  const list = getProjects(owner);
  if (!list.length) {
    // first run: migrate any legacy save, otherwise start from the demo house
    let legacyObjs = [];
    try {
      const auto = readAutosave();
      if (auto && auto.objects && auto.objects.length) legacyObjs = auto.objects;
      else {
        const raw = localStorage.getItem('sitematrix3d.save');
        const sv = raw ? JSON.parse(raw) : null;
        if (sv && sv.objects && sv.objects.length) legacyObjs = sv.objects;
      }
    } catch (e) { /* ignore */ }
    const firstName = owner === 'guest' ? 'Demo Sandbox' : 'My First Project';
    const rec = createProject(owner, firstName, []);
    currentProjectId = rec.id;
    setCurrentProjectId(owner, rec.id);
    if (legacyObjs.length) {
      restoreScene(legacyObjs);
      persistCurrentProject(true);
      toast('👋 Welcome back — your previous work was moved into "' + firstName + '"');
    } else {
      demoBuild();
      persistCurrentProject(false);
      afterChange();
      toast('👋 Welcome to SITE MATRIX 3D — click any part of the demo house to move it!');
    }
    try {
      localStorage.removeItem('sitematrix3d.autosave');
      localStorage.removeItem('sitematrix3d.save');
    } catch (e) { /* ignore */ }
  } else {
    const savedId = getCurrentProjectId(owner);
    const target = list.find((p) => p.id === savedId) || list[0];
    currentProjectId = target.id;
    setCurrentProjectId(owner, currentProjectId);
    restoreScene(target.objects || []);
    toast('👋 Welcome back — opened "' + target.name + '"');
  }
  undoStack.length = 0;
  redoStack.length = 0;
  updateUndoRedo();
  const proj = getCurrentProject();
  if (proj) $('project-name').value = proj.name;
  renderProjects();
  renderSessionUI();
}

function newProject() {
  if (!requireActivation('create a new project')) return;
  persistCurrentProject(true); // stash outgoing project including thumbnail
  const list = getProjects(owner);
  const rec = createProject(owner, 'Untitled Project ' + (list.length + 1), []);
  currentProjectId = rec.id;
  setCurrentProjectId(owner, rec.id);
  try { if (window.AI_ON_PROJECT) window.AI_ON_PROJECT(rec.id); } catch (e) {}
  undoStack.length = 0;
  redoStack.length = 0;
  updateUndoRedo();
  deselect();
  clearObjectsOnly();
  if (holoStyle !== 'real') fitHoloRig();
  afterChange();
  renderPropsPanel();
  $('project-name').value = rec.name;
  renderProjects();
  toast('📁 New project "' + rec.name + '" — start building!');
}

function switchProject(id) {
  if (id === currentProjectId) return;
  const target = getProjects(owner).find((p) => p.id === id);
  if (!target) return;
  persistCurrentProject(true);
  currentProjectId = id;
  setCurrentProjectId(owner, id);
  try { if (window.AI_ON_PROJECT) window.AI_ON_PROJECT(id); } catch (e) {}
  undoStack.length = 0;
  redoStack.length = 0;
  updateUndoRedo();
  restoreScene(target.objects || []);
  $('project-name').value = target.name;
  renderProjects();
  toast('📂 Opened "' + target.name + '"');
}

function renameCurrentProject(name) {
  const proj = getCurrentProject();
  name = (name || '').trim();
  if (!proj) return;
  if (!name) { $('project-name').value = proj.name; return; }
  touchProject(owner, proj.id, { name });
  $('project-name').value = name;
  renderProjects();
  updateStatus();
}

function duplicateProject(id) {
  if (!requireActivation('duplicate projects')) return;
  const src = getProjects(owner).find((p) => p.id === id);
  if (!src) return;
  const copy = JSON.parse(JSON.stringify(src.objects || []));
  const rec = createProject(owner, src.name + ' (copy)', copy);
  if (src.thumb) touchProject(owner, rec.id, { thumb: src.thumb });
  renderProjects();
  toast('⧉ Duplicated as "' + rec.name + '"');
}

function deleteProjectFlow(id) {
  const p = getProjects(owner).find((x) => x.id === id);
  if (!p) return;
  if (!window.confirm('Delete project "' + p.name + '"? This cannot be undone.')) return;
  deleteProject(owner, id);
  let rest = getProjects(owner);
  if (!rest.length) {
    const rec = createProject(owner, owner === 'guest' ? 'Demo Sandbox' : 'My First Project', []);
    rest = [rec];
  }
  if (id === currentProjectId) {
    currentProjectId = rest[0].id;
    setCurrentProjectId(owner, currentProjectId);
    try { if (window.AI_ON_PROJECT) window.AI_ON_PROJECT(rest[0].id); } catch (e) {}
    undoStack.length = 0;
    redoStack.length = 0;
    updateUndoRedo();
    restoreScene(rest[0].objects || []);
    $('project-name').value = rest[0].name;
  }
  renderProjects();
  toast('🗑 Deleted "' + p.name + '"');
}

function renderProjects() {
  const wrap = $('projects-list');
  if (!wrap) return;
  const list = getProjects(owner);
  wrap.innerHTML = '';
  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'outline-empty';
    d.textContent = 'No projects yet.';
    wrap.appendChild(d);
    return;
  }
  const sorted = [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  sorted.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'project-card' + (p.id === currentProjectId ? ' current' : '');
    if (p.thumb) {
      const img = document.createElement('img');
      img.className = 'project-thumb';
      img.src = p.thumb;
      img.alt = '';
      card.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'project-thumb placeholder';
      ph.textContent = '🏗️';
      card.appendChild(ph);
    }
    const meta = document.createElement('div');
    meta.className = 'project-meta';
    const nm = document.createElement('div');
    nm.className = 'project-name';
    nm.textContent = p.name;
    const sub = document.createElement('div');
    sub.className = 'project-sub';
    const n = (p.objects || []).length;
    sub.textContent = n + ' object' + (n === 1 ? '' : 's') + ' • ' + fmtDate(p.updatedAt);
    meta.append(nm, sub);
    card.appendChild(meta);
    const actions = document.createElement('div');
    actions.className = 'project-actions';
    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.className = 'mini-btn';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
      return b;
    };
    if (p.id !== currentProjectId) {
      actions.appendChild(mk('Open', 'Open this project', () => switchProject(p.id)));
    } else {
      const cur = document.createElement('span');
      cur.className = 'current-tag';
      cur.textContent = '● current';
      actions.appendChild(cur);
    }
    actions.appendChild(mk('⧉', ACTIVATED ? 'Duplicate project' : 'Duplicate project (PRO)', () => duplicateProject(p.id)));
    actions.appendChild(mk('🗑', 'Delete project', () => deleteProjectFlow(p.id)));
    card.appendChild(actions);
    card.addEventListener('click', () => { if (p.id !== currentProjectId) switchProject(p.id); });
    wrap.appendChild(card);
  });
}

function persistCurrentProject(withThumb) {
  const proj = getCurrentProject();
  if (!proj) return;
  const patch = { objects: serializeScene(), updatedAt: Date.now() };
  if (withThumb) {
    try {
      const t = captureThumbnail();
      if (t) patch.thumb = t;
    } catch (e) { /* ignore */ }
  }
  touchProject(owner, proj.id, patch);
}

function saveCurrentProject(manual) {
  const proj = getCurrentProject();
  if (!proj) return;
  persistCurrentProject(true);
  if (manual) {
    renderProjects();
    toast('💾 Project "' + proj.name + '" saved (' + objects.length + ' objects)');
  }
}

function captureThumbnail() {
  try {
    renderer.render(scene, camera);
    const src = renderer.domElement;
    const c = document.createElement('canvas');
    const W = 220;
    const H = Math.max(1, Math.round(W * src.height / Math.max(1, src.width)));
    c.width = W;
    c.height = H;
    c.getContext('2d').drawImage(src, 0, 0, W, H);
    return c.toDataURL('image/jpeg', 0.6);
  } catch (e) { return null; }
}

/* =====================================================================
   HOLOGRAPHIC STUDIO
   ===================================================================== */

function buildHoloRig() {
  HOLO.solidMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.28, depthWrite: false });
  HOLO.solidMat.userData.sharedHolo = true;
  HOLO.volMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.10, depthWrite: false });
  HOLO.volMat.userData.sharedHolo = true;
  HOLO.pointsMat = new THREE.PointsMaterial({
    color: 0x9df6ff, size: 0.055, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
  });
  HOLO.pointsMat.userData.sharedHolo = true;

  holoRig = new THREE.Group();
  holoRig.visible = false;

  holoDisc = new THREE.Mesh(
    new THREE.CircleGeometry(1, 48),
    new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
  );
  holoDisc.rotation.x = -Math.PI / 2;
  holoDisc.position.y = 0.04;
  holoDisc.raycast = () => {};

  holoRing1 = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.015, 8, 72),
    new THREE.MeshBasicMaterial({ color: 0x33f0ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  holoRing1.rotation.x = Math.PI / 2;
  holoRing1.position.y = 0.06;
  holoRing1.raycast = () => {};

  holoRing2 = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.01, 8, 72),
    new THREE.MeshBasicMaterial({ color: 0x7c5cff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  holoRing2.rotation.x = Math.PI / 2;
  holoRing2.position.y = 0.06;
  holoRing2.raycast = () => {};

  const dotGeo = new THREE.SphereGeometry(0.06, 12, 12);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xaef7ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
  holoDot1 = new THREE.Mesh(dotGeo, dotMat);
  holoDot2 = new THREE.Mesh(dotGeo, dotMat);
  holoDot1.raycast = () => {};
  holoDot2.raycast = () => {};

  holoScan = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0x66f6ff, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
  );
  holoScan.rotation.x = -Math.PI / 2;
  holoScan.visible = false;
  holoScan.raycast = () => {};

  // XYZ axes at the structure base
  holoAxes = new THREE.AxesHelper(1);
  holoAxes.traverse((c) => { c.raycast = () => {}; });

  holoRig.add(holoDisc, holoRing1, holoRing2, holoDot1, holoDot2, holoScan, holoAxes);
  scene.add(holoRig);
}

function structureBox() {
  if (!objects.length) return null;
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  let has = false;
  for (const o of objects) {
    if (!o.visible) continue;
    tmp.setFromObject(o);
    if (tmp.isEmpty()) continue;
    if (!has) { box.copy(tmp); has = true; }
    else box.union(tmp);
  }
  return has ? box : null;
}

function setRenderStyle(style) {
  if (['real', 'solid', 'exploded', 'volumetric'].indexOf(style) === -1) return;
  if (style === holoStyle) return;
  exitHolo();
  holoStyle = style;
  if (style !== 'real') enterHolo(style);
  document.querySelectorAll('#style-group .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.style === style));
  $('explode-control').classList.toggle('hidden', style !== 'exploded');
  $('holo-hud').classList.toggle('hidden', style === 'real');
  $('scanlines').classList.toggle('hidden', style === 'real');
  // recolor selection outline for contrast against the hologram
  if (selectionHelper && selected) {
    scene.remove(selectionHelper);
    selectionHelper.geometry.dispose();
    selectionHelper.material.dispose();
    selectionHelper = new THREE.BoxHelper(selected, style === 'real' ? 0x00e5ff : 0xff5df2);
    selectionHelper.visible = selected.visible;
    scene.add(selectionHelper);
  }
  updateHUD();
  updateStatus();
  if (style === 'real') toast('🧊 Real render');
  else if (style === 'solid') toast('👻 Hologram · Solid wire mode — auto-rotating');
  else if (style === 'exploded') toast('💥 Hologram · Exploded mode — drag Spread to separate parts');
  else toast('✨ Hologram · Volumetric mode — particle scan');
}

function enterHolo(style) {
  for (const o of objects) applyHoloMaterialToObject(o);
  if (style === 'volumetric') for (const o of objects) addHoloPoints(o);
  if (style === 'exploded') computeExplodeOffsets();
  holoRig.visible = true;
  holoScan.visible = (style === 'volumetric');
  fitHoloRig();
  // holographic auto-rotation
  spinBeforeHolo = orbit.autoRotate;
  orbit.autoRotate = true;
  orbit.autoRotateSpeed = 1.1;
  syncSpinButton();
}

function exitHolo() {
  if (holoStyle === 'real') return;
  if (holoStyle === 'exploded') clearExplodeState();
  for (const o of objects) {
    removeHoloPoints(o);
    restoreHoloMaterials(o);
  }
  holoRig.visible = false;
  holoScan.visible = false;
  orbit.autoRotate = spinBeforeHolo;
  syncSpinButton();
  updateEdgeColors();
  updateStatus();
}

function applyHoloMaterialToObject(obj) {
  const mat = holoStyle === 'volumetric' ? HOLO.volMat : HOLO.solidMat;
  obj.traverse((c) => {
    if (!c.isMesh) return;
    if (!c.userData._origMat) {
      c.userData._origMat = c.material;
      c.userData._origShadow = c.castShadow;
    }
    c.material = mat;
    c.castShadow = false;
  });
  obj.traverse((c) => {
    if (c.userData && c.userData.isEdge) {
      c.material.color.set(0x8ff7ff);
      c.material.opacity = 0.95;
    }
  });
}

function restoreHoloMaterials(obj) {
  obj.traverse((c) => {
    if (!c.isMesh) return;
    if (c.userData._origMat) {
      c.material = c.userData._origMat;
      c.userData._origMat = null;
      c.castShadow = c.userData._origShadow !== false;
    }
  });
}

function addHoloPoints(obj) {
  obj.traverse((c) => {
    if (c.isMesh && !c.userData._hasHoloPoints) {
      c.userData._hasHoloPoints = true;
      const pts = new THREE.Points(c.geometry, HOLO.pointsMat);
      pts.userData.isHoloPoints = true;
      pts.raycast = () => {};
      c.add(pts);
    }
  });
}

function removeHoloPoints(obj) {
  const kill = [];
  obj.traverse((c) => { if (c.userData && c.userData.isHoloPoints) kill.push(c); });
  kill.forEach((p) => { if (p.parent) p.parent.remove(p); });
  obj.traverse((c) => { if (c.isMesh) c.userData._hasHoloPoints = false; });
}

function applyHoloToNewObject(obj) {
  if (holoStyle === 'real') return;
  applyHoloMaterialToObject(obj);
  if (holoStyle === 'volumetric') addHoloPoints(obj);
  if (holoStyle === 'exploded') {
    const dir = explodeDirFor(obj, explodeCentroid);
    obj.userData._expDir = dir;
    obj.position.addScaledVector(dir, explodeFactor);
  }
  fitHoloRig();
  updateHUD();
}

/* ---- exploded view ---- */

function explodeDirFor(obj, centroid) {
  const c = new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
  const d = c.sub(centroid);
  if (d.lengthSq() < 1e-6) d.set(0, 1, 0);
  d.y += 0.1 * d.length(); // slight upward bias for a layered blast
  return d.normalize();
}

function computeExplodeOffsets() {
  const box = structureBox();
  if (!box || !objects.length) { explodeCentroid.set(0, 0, 0); return; }
  explodeCentroid = box.getCenter(new THREE.Vector3());
  for (const o of objects) {
    const dir = explodeDirFor(o, explodeCentroid);
    o.userData._expDir = dir;
    o.position.addScaledVector(dir, explodeFactor);
  }
}

function setExplodeFactor(v) {
  v = Math.max(0, Math.min(3, Number(v) || 0));
  const delta = v - explodeFactor;
  explodeFactor = v;
  $('explode-val').textContent = v.toFixed(1) + 'm';
  if (holoStyle !== 'exploded') return;
  for (const o of objects) {
    if (o.userData._expDir) o.position.addScaledVector(o.userData._expDir, delta);
  }
  fitHoloRig();
  updateHUD();
  scheduleAutosave();
}

function clearExplodeState() {
  for (const o of objects) {
    if (o.userData._expDir) {
      o.position.addScaledVector(o.userData._expDir, -explodeFactor);
      o.userData._expDir = null;
    }
  }
}

/* ---- holo rig / animation / HUD ---- */

function fitHoloRig() {
  const box = structureBox();
  if (!box) {
    holoRig.visible = false;
    rigBounds.size.set(1, 1, 1);
    return;
  }
  holoRig.visible = true;
  rigBounds.min.copy(box.min);
  rigBounds.max.copy(box.max);
  rigBounds.center.copy(box.getCenter(new THREE.Vector3()));
  rigBounds.size.copy(box.getSize(new THREE.Vector3()));
  const r = Math.max(rigBounds.size.x, rigBounds.size.z) / 2 + 1.2;
  rigBounds.radius = r;
  holoRig.position.set(rigBounds.center.x, 0, rigBounds.center.z);
  holoDisc.scale.set(r, r, 1);
  holoRing1.scale.set(r, r, r);
  holoRing2.scale.set(r * 0.78, r * 0.78, r * 0.78);
  holoScan.scale.set(Math.max(rigBounds.size.x, 0.5) + 1.5, Math.max(rigBounds.size.z, 0.5) + 1.5, 1);
  holoScan.position.set(0, rigBounds.min.y + 0.1, 0);
  const ax = Math.max(rigBounds.size.x, rigBounds.size.y, rigBounds.size.z, 0.5);
  holoAxes.scale.set(ax * 0.7, ax * 0.7, ax * 0.7);
  holoAxes.position.set(0, Math.max(0.05, rigBounds.min.y), 0);
}

function tickHolo() {
  if (holoStyle === 'real' || !holoRig.visible) return;
  const t = performance.now() / 1000;
  const r = rigBounds.radius || 3;
  holoDot1.position.set(Math.cos(t * 0.9) * r, 0.07, Math.sin(t * 0.9) * r);
  holoDot2.position.set(Math.cos(t * 0.9 + Math.PI) * r * 0.78, 0.07, Math.sin(t * 0.9 + Math.PI) * r * 0.78);
  holoDisc.material.opacity = 0.06 + 0.025 * Math.sin(t * 2.2);
  // subtle hologram flicker
  const fl = 1 + 0.06 * Math.sin(t * 27) + (Math.random() < 0.015 ? -0.25 : 0);
  HOLO.solidMat.opacity = 0.28 * fl;
  HOLO.volMat.opacity = 0.10 * fl;
  if (holoStyle === 'volumetric' && holoScan.visible) {
    const h = Math.max(rigBounds.size.y, 0.5);
    const y0 = rigBounds.min.y;
    holoScan.position.y = y0 + ((t * 1.4) % (h + 0.6)) - 0.3;
    holoScan.material.opacity = 0.12 + 0.05 * Math.sin(t * 6);
  }
}

function toggleSpin() {
  orbit.autoRotate = !orbit.autoRotate;
  if (orbit.autoRotate) orbit.autoRotateSpeed = 1.1;
  syncSpinButton();
  updateHUD();
  updateStatus();
}

function syncSpinButton() {
  const b = $('btn-spin');
  if (b) b.classList.toggle('active', !!orbit.autoRotate);
}

function updateHUD() {
  if (holoStyle === 'real') return;
  const set = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
  const f2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
  const box = structureBox();
  if (!box) {
    set('hud-dimx', '–'); set('hud-dimy', '–'); set('hud-dimz', '–');
    set('hud-center', '( – )'); set('hud-vol', '–');
    set('hud-parts', '0'); set('hud-min', '–'); set('hud-max', '–');
  } else {
    const s = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    set('hud-dimx', f2(s.x) + ' m');
    set('hud-dimy', f2(s.y) + ' m');
    set('hud-dimz', f2(s.z) + ' m');
    set('hud-center', '(' + f2(c.x) + ', ' + f2(c.y) + ', ' + f2(c.z) + ')');
    set('hud-vol', f2(s.x * s.y * s.z) + ' m³');
    set('hud-parts', String(objects.length));
    set('hud-min', '(' + f2(box.min.x) + ', ' + f2(box.min.y) + ', ' + f2(box.min.z) + ')');
    set('hud-max', '(' + f2(box.max.x) + ', ' + f2(box.max.y) + ', ' + f2(box.max.z) + ')');
  }
  if (selected) {
    const p = selected.position.clone();
    if (holoStyle === 'exploded' && selected.userData._expDir) {
      p.addScaledVector(selected.userData._expDir, -explodeFactor);
    }
    set('hud-sel', selected.userData.name + ' @(' + f2(p.x) + ',' + f2(p.y) + ',' + f2(p.z) + ')');
  } else {
    set('hud-sel', '—');
  }
  const modeNames = { solid: 'HOLO·SOLID', exploded: 'HOLO·EXPLODED', volumetric: 'HOLO·VOLUMETRIC' };
  set('hud-mode', modeNames[holoStyle] || holoStyle);
  set('hud-rot', orbit && orbit.autoRotate ? 'ROT·AUTO ⟳' : 'ROT·HELD');
}


/* ================= SPIN RING (drag-to-rotate in viewport) =================
   In Select mode, the selected block gets a glowing turntable ring on the
   ground. Drag the ring left/right to spin the block (snaps to 15 degrees
   when Snap is on). Q / E keys quick-rotate by one step. */

let spinRing = null;
let spinRingMat = null;
let spinKnob = null;
let spinProxy = null;
let ringSuppressPick = false;
let ringHovering = false;

function buildSpinRing() {
  spinRing = new THREE.Group();
  spinRingMat = new THREE.MeshBasicMaterial({ color: 0x33f0ff, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false });
  const torus = new THREE.Mesh(new THREE.TorusGeometry(1, 0.03, 10, 72), spinRingMat);
  torus.rotation.x = Math.PI / 2;
  // fat invisible grab proxy so the thin ring is easy to catch
  spinProxy = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.16, 8, 48),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true, opacity: 0 })
  );
  spinProxy.rotation.x = Math.PI / 2;
  const knobMat = new THREE.MeshBasicMaterial({ color: 0xaef7ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
  spinKnob = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 16), knobMat);
  spinRing.add(torus, spinProxy, spinKnob);
  spinRing.visible = false;
  scene.add(spinRing);
}

function updateSpinRing() {
  if (!spinRing) buildSpinRing();
  const show = !!selected && tool === 'select' && !selected.userData.locked && selected.visible;
  spinRing.visible = show;
  if (!show) { ringHovering = false; return; }
  try {
    const box = new THREE.Box3().setFromObject(selected);
    if (box.isEmpty()) { spinRing.visible = false; return; }
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const r = Math.max(Math.max(size.x, size.z) / 2 + 0.7, 1.0);
    spinRing.position.set(center.x, Math.max(box.min.y + 0.06, 0.05), center.z);
    spinRing.scale.set(r, 1, r);
    spinRing.rotation.y = selected.rotation.y;
    spinKnob.position.set(1, 0, 0);
    spinKnob.scale.set(1 / r, 1, 1 / r);
  } catch (e) { spinRing.visible = false; }
}

function hideSpinRing() {
  ringHovering = false;
  if (spinRing) spinRing.visible = false;
}

function tickSpinRing() {
  if (!spinRing || !spinRing.visible) return;
  const t = performance.now() / 1000;
  spinRingMat.opacity = (ringHovering ? 0.95 : 0.6) + 0.15 * Math.sin(t * 3);
  if (selected) spinRing.rotation.y = selected.rotation.y;
}

function bindSpinRing() {
  if (!spinRing) buildSpinRing();
  if (spinRing.userData.bound) return;
  spinRing.userData.bound = true;
  const el = renderer.domElement;
  const ray = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  let dragging = false;
  let startX = 0;
  let startDeg = 0;

  const castRing = (e) => {
    const rect = el.getBoundingClientRect();
    ptr.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ptr.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(ptr, camera);
    return ray.intersectObjects([spinProxy, spinKnob], false).length > 0;
  };

  el.addEventListener('pointermove', (e) => {
    if (!spinRing.visible || dragging) return;
    ringHovering = castRing(e);
    el.style.cursor = ringHovering ? 'grab' : '';
  });

  el.addEventListener('pointerdown', (e) => {
    if (!spinRing.visible || e.button !== 0 || !selected) return;
    if (!castRing(e)) return;
    dragging = true;
    ringSuppressPick = true;
    orbit.enabled = false; // set false here; orbit's move handler respects it
    propSnapshot = serializeScene();
    startX = e.clientX;
    startDeg = THREE.MathUtils.radToDeg(selected.rotation.y);
    el.style.cursor = 'grabbing';
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.stopPropagation();
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging || !selected) return;
    let deg = startDeg + (e.clientX - startX) * 0.45;
    if (snapEnabled) deg = Math.round(deg / 15) * 15;
    selected.rotation.y = THREE.MathUtils.degToRad(deg);
    spinRing.rotation.y = selected.rotation.y;
    syncPropNumbers();
    updateDims();
    if (holoStyle !== 'real') { fitHoloRig(); updateHUD(); }
  });

  const up = () => {
    if (!dragging) return;
    dragging = false;
    ringSuppressPick = false;
    orbit.enabled = true;
    el.style.cursor = '';
    commitPropSnapshot();
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

function quickRotate(dir, isRepeat) {
  if (!selected) return;
  if (selected.userData.locked) { toast('🔒 Object is locked'); return; }
  if (!isRepeat) pushHistory();
  const step = snapEnabled ? 15 : 5;
  selected.rotation.y += THREE.MathUtils.degToRad(dir * step);
  afterChange();
}


/* ============ ALT-DRAG DUPLICATE + RIGHT-CLICK MENU ============
   Hold Alt and drag any transform gizmo to drag out a live copy.
   Right-click a block for Duplicate / Focus / Rotate / Delete. */

let altHeld = false;

function bindAltClone() {
  window.addEventListener('keydown', (e) => { if (e.key === 'Alt') altHeld = true; });
  window.addEventListener('keyup', (e) => { if (e.key === 'Alt') altHeld = false; });
  window.addEventListener('blur', () => { altHeld = false; });
  window.addEventListener('pointerdown', (e) => { altHeld = !!e.altKey; }, true);
  window.addEventListener('pointermove', (e) => { altHeld = !!e.altKey; }, true);
}

function showCtxMenu(x, y) {
  const menu = $('ctx-menu');
  if (!menu) return;
  const w = 196, h = 172;
  menu.style.left = Math.min(Math.max(x, 8), window.innerWidth - w - 8) + 'px';
  menu.style.top = Math.min(Math.max(y, 8), window.innerHeight - h - 8) + 'px';
  menu.classList.remove('hidden');
}

function hideCtxMenu() {
  const m = $('ctx-menu');
  if (m) m.classList.add('hidden');
}

function bindCtxMenu() {
  const el = renderer.domElement;
  const menu = $('ctx-menu');
  if (!el || !menu || menu.dataset.bound) return;
  menu.dataset.bound = '1';
  let rx = 0, ry = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.button === 2) { rx = e.clientX; ry = e.clientY; }
  });
  el.addEventListener('pointerup', (e) => {
    if (e.button !== 2) return;
    if (Math.hypot(e.clientX - rx, e.clientY - ry) > 6) return; // it was a pan
    pick(e); // right-click selects first, like pro 3D tools
    if (!selected) { hideCtxMenu(); return; }
    showCtxMenu(e.clientX, e.clientY);
  });
  $('ctx-duplicate').addEventListener('click', () => { hideCtxMenu(); duplicateSelected(); });
  $('ctx-focus').addEventListener('click', () => { hideCtxMenu(); focusSelected(); });
  $('ctx-rot45').addEventListener('click', () => {
    hideCtxMenu();
    if (!selected) return;
    pushHistory();
    selected.rotation.y += Math.PI / 4;
    afterChange();
  });
  $('ctx-delete').addEventListener('click', () => { hideCtxMenu(); deleteSelected(); });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target)) hideCtxMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });
  window.addEventListener('blur', hideCtxMenu);
}

/* ---------------- boot ---------------- */
init();

/* ---------------- custom size block (m / cm / mm) ----------------
   Scene unit = 1 metre. Users type Length(X) x Height(Y) x Width(Z) in
   their chosen unit; values are converted to metres for geometry. */

function makeCustomBlock(name, dims) {
  const d = Array.isArray(dims) ? dims : [1, 1, 1];
  const w = Math.min(100, Math.max(0.001, Number(d[0]) || 1));
  const h = Math.min(100, Math.max(0.001, Number(d[1]) || 1));
  const dep = Math.min(100, Math.max(0.001, Number(d[2]) || 1));
  const obj = finalize(boxMesh(w, h, dep, '#c9b48a'), 'custom', name, '#c9b48a');
  obj.userData.dims = [w, h, dep];
  return obj;
}

const CBX_UNIT_TO_M = { m: 1, cm: 0.01, mm: 0.001 };

function cbxTrim(n) {
  return String(Math.round(Number(n) * 1000) / 1000);
}

function cbxReadout() {
  const el = document.getElementById('cbx-readout');
  if (!el) return;
  const unitEl = document.getElementById('cbx-unit');
  const f = (unitEl && CBX_UNIT_TO_M[unitEl.value]) || 1;
  const L = (parseFloat(document.getElementById('cbx-len').value) || 0) * f;
  const H = (parseFloat(document.getElementById('cbx-hei').value) || 0) * f;
  const W = (parseFloat(document.getElementById('cbx-wid').value) || 0) * f;
  el.textContent = '≈ ' + cbxTrim(L) + ' × ' + cbxTrim(H) + ' × ' + cbxTrim(W) + ' m';
}

function bindCustomBlock() {
  const btn = document.getElementById('cbx-add');
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  ['cbx-len', 'cbx-hei', 'cbx-wid', 'cbx-unit'].forEach((id) => {
    const inp = document.getElementById(id);
    if (!inp) return;
    inp.addEventListener('input', cbxReadout);
    inp.addEventListener('change', cbxReadout);
  });
  cbxReadout();
  btn.addEventListener('click', () => {
    const unit = document.getElementById('cbx-unit').value;
    const f = CBX_UNIT_TO_M[unit] || 1;
    const rawL = parseFloat(document.getElementById('cbx-len').value);
    const rawH = parseFloat(document.getElementById('cbx-hei').value);
    const rawW = parseFloat(document.getElementById('cbx-wid').value);
    if (![rawL, rawH, rawW].every((v) => isFinite(v) && v > 0)) {
      toast('⚠️ Enter a Length, Height and Width greater than 0.');
      return;
    }
    let clamped = false;
    const dims = [rawL * f, rawH * f, rawW * f].map((v) => {
      if (v > 100) { clamped = true; return 100; }
      if (v < 0.001) { clamped = true; return 0.001; }
      return v;
    });
    addBlock('custom', { dims });
    toast('📐 Custom block ' + cbxTrim(rawL) + ' × ' + cbxTrim(rawH) + ' × ' + cbxTrim(rawW) + ' ' + unit +
      ' (≈ ' + cbxTrim(dims[0]) + ' × ' + cbxTrim(dims[1]) + ' × ' + cbxTrim(dims[2]) + ' m)' +
      (clamped ? ' — clamped to 0.001–100 m' : ''));
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindCustomBlock);
else bindCustomBlock();

/* -------- Matrix Assistant bridge (ai.js reads scene state + places blocks) -------- */
window.SM3D = {
  version: 'site-matrix-3d v3 + ai',
  scene() {
    const types = {};
    objects.forEach((o) => {
      const t = (o.userData && o.userData.type) || 'block';
      const label = (BLOCK_DEFS[t] && BLOCK_DEFS[t].label) || t;
      types[label] = (types[label] || 0) + 1;
    });
    return { count: objects.length, types, names: objects.map((o) => o.userData.name) };
  },
  selected() {
    if (!selected) return null;
    const t = selected.userData.type;
    return { name: selected.userData.name, type: (BLOCK_DEFS[t] && BLOCK_DEFS[t].label) || t };
  },
  addBlock(type) { addBlock(type); },
  addCustom(L, H, W) { addBlock('custom', { dims: [Number(L), Number(H), Number(W)] }); },
  subscribe(what) { requireActivation(what || 'unlock PRO features'); },
  isPro() { try { return ACTIVATED === true; } catch (e) { return false; } },
  projectId() { try { return currentProjectId; } catch (e) { return null; } },
  help() { openHelp(); },
  toast(msg) { toast(msg); }
};

/* -------- Matrix Assistant: full build + feature bridge (used by ai.js plans) -------- */
Object.assign(window.SM3D, {
  catalog() {
    if (window.__sm3dCatalog) return window.__sm3dCatalog;
    const cat = {};
    Object.keys(BLOCK_DEFS).forEach((t) => {
      if (t === 'custom') { cat.custom = { size: [1, 1, 1], groundY: 0.5, note: 'any LxHxW' }; return; }
      try {
        const tmp = BLOCK_DEFS[t].make('__measure__');
        tmp.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(tmp);
        const r2 = (v) => Math.round(v * 100) / 100;
        cat[t] = {
          size: [r2(box.max.x - box.min.x), r2(box.max.y - box.min.y), r2(box.max.z - box.min.z)],
          groundY: r2(-box.min.y)
        };
        disposeObject(tmp);
      } catch (e) { /* skip unmeasurable */ }
    });
    window.__sm3dCatalog = cat;
    return cat;
  },
  resolveTarget(ref) {
    if (!ref) return null;
    const r = String(ref).toLowerCase();
    if (r === 'selected') return selected;
    if (r === 'last') return objects.length ? objects[objects.length - 1] : null;
    return objects.find((o) => (o.userData.name || '').toLowerCase() === r)
      || objects.find((o) => (o.userData.name || '').toLowerCase().includes(r)) || null;
  },
  addAt(type, x, y, z, rotY, color) {
    if (!BLOCK_DEFS[type] || type === 'custom') return null;
    const before = objects.length;
    addBlock(type, (x === null || x === undefined) ? {} : { position: [x, y, z] });
    if (objects.length <= before) return null;
    const o = objects[objects.length - 1];
    if (rotY) o.rotation.y = rotY * Math.PI / 180;
    if (color) applyColor(o, color);
    afterChange();
    return o.userData.name;
  },
  customAt(L, H, W, x, y, z, rotY, color) {
    const before = objects.length;
    addBlock('custom', { dims: [L, H, W] });
    if (objects.length <= before) return null;
    const o = objects[objects.length - 1];
    if (x !== null && x !== undefined) o.position.set(x, y, z);
    if (rotY) o.rotation.y = rotY * Math.PI / 180;
    if (color) applyColor(o, color);
    afterChange();
    return o.userData.name;
  },
  moveBy(ref, dx, dy, dz) {
    const o = window.SM3D.resolveTarget(ref);
    if (!o) return null;
    o.position.x += dx; o.position.y += dy; o.position.z += dz;
    afterChange();
    return o.userData.name;
  },
  moveTo(ref, x, y, z) {
    const o = window.SM3D.resolveTarget(ref);
    if (!o) return null;
    o.position.set(x, y, z);
    afterChange();
    return o.userData.name;
  },
  turnBy(ref, deg) {
    const o = window.SM3D.resolveTarget(ref);
    if (!o) return null;
    o.rotation.y += deg * Math.PI / 180;
    afterChange();
    return o.userData.name;
  },
  removeTarget(ref) {
    const o = window.SM3D.resolveTarget(ref);
    if (!o) return null;
    const name = o.userData.name;
    select(o);
    deleteSelected();
    return name;
  },
  clearAll() {
    deselect();
    clearObjectsOnly();
    afterChange();
    return 'cleared';
  },
  setColor(ref, hex) {
    const o = window.SM3D.resolveTarget(ref);
    if (!o || !hex) return null;
    applyColor(o, hex);
    const pc = document.getElementById('prop-color');
    if (pc && selected === o) pc.value = hex;
    afterChange();
    return o.userData.name;
  },
  setLocked(ref, on) {
    const o = window.SM3D.resolveTarget(ref);
    if (!o) return null;
    select(o);
    o.userData.locked = !!on;
    if (o.userData.locked) tc.detach();
    else if (tool !== 'select') tc.attach(o);
    const pl = document.getElementById('prop-locked');
    if (pl) pl.checked = !!on;
    afterChange();
    return o.userData.name;
  },
  selectTarget(ref) {
    const o = window.SM3D.resolveTarget(ref);
    if (!o) return null;
    select(o);
    return o.userData.name;
  },
  focusTarget(ref) {
    const o = window.SM3D.resolveTarget(ref);
    if (!o) return null;
    select(o);
    focusSelected();
    return o.userData.name;
  },
  setStyle(name) {
    if (!['real', 'solid', 'exploded', 'volumetric'].includes(name)) return null;
    setRenderStyle(name);
    document.querySelectorAll('#style-group [data-style]').forEach((b) =>
      b.classList.toggle('active', b.dataset.style === name));
    return name;
  },
  setSpin(on) {
    orbit.autoRotate = !!on;
    if (on) orbit.autoRotateSpeed = 1.1;
    syncSpinButton();
    updateStatus();
    return !!on;
  },
  setExplode(v) {
    v = Math.min(3, Math.max(0, Number(v) || 0));
    setExplodeFactor(v);
    const r = document.getElementById('explode-range');
    if (r) r.value = v;
    return v;
  },
  setSnap(on, size) {
    snapEnabled = !!on;
    if (isFinite(size)) snapSize = Math.min(2, Math.max(0.05, Number(size)));
    applySnap();
    updateStatus();
    const se = document.getElementById('snap-enabled');
    if (se) se.checked = !!on;
    const ss = document.getElementById('snap-size');
    if (ss && isFinite(size)) {
      const s = String(size);
      if ([...ss.options].some((o) => o.value === s)) ss.value = s;
    }
    return snapEnabled;
  },
  setGrid(on) {
    grid.visible = !!on;
    const cb = document.getElementById('grid-visible');
    if (cb) cb.checked = !!on;
    return grid.visible;
  },
  saveNow() { saveManual(); return 'saved'; },
  exportNow() { exportJSON(); return 'exported'; },
  importNow() { document.getElementById('file-import').click(); return 'picker'; },
  pngNow() { exportPNG(); return 'png'; },
  newProjectNow() { newProject(); return 'new'; },
  undoNow() { undo(); return 'undone'; },
  redoNow() { redo(); return 'redone'; },
  setToolNow(name) {
    if (!['select', 'translate', 'rotate', 'scale'].includes(name)) return null;
    setTool(name);
    return name;
  },
  beginBatch() { pushHistory(); batchHistory = true; window.__sm3dBatch = true; return true; },
  endBatch() { batchHistory = false; window.__sm3dBatch = false; afterChange(); updateUndoRedo(); return true; },
  sync() { afterChange(); return true; }
});
