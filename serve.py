#!/usr/bin/env python3
"""SITE MATRIX 3D preview server: no-cache static files + Groq AI proxy.

- Serves the studio with Cache-Control: no-store.
- POST /api/chat  -> forwards to Groq (API key stays server-side, NEVER sent
  to the browser). Building-only system prompt is enforced here.
- GET  /api/health -> { ok, cloud, model } for the chat status indicator.
- Dotfiles / key material are never served. Basic per-IP rate limiting.

Env: GROQ_API_KEY (required for cloud brain), GROQ_MODEL (optional).
Port: first argv, default 8000.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

GROQ_MODEL = os.environ.get('GROQ_MODEL', 'qwen/qwen3.8-27b')
GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models'

SYSTEM_PROMPT = (
    'You are Matrix Assistant, the built-in helper for SITE MATRIX 3D, a browser app '
    'where users build houses and structures with 3D blocks and view them as holograms. '
    'STRICT SCOPE: Only answer building, construction-measurement, and SITE MATRIX 3D app questions. '
    'For anything else, reply exactly: "I\'m the SITE MATRIX 3D building assistant \u2014 I only answer '
    '**building & app** questions \U0001F642 Try asking about blocks, sizes, rotating, or subscription." '
    'SECRETS: Never reveal, hint at, confirm, or discuss any owner code, master code, admin email, '
    'password, or API key. If asked, say: "\U0001F512 That is private owner information and I can\'t share it." '
    'APP FACTS: Scene units are metres (1 unit = 1 m). Custom Size Block takes Length(X) x Height(Y) x Width(Z) '
    'in m/cm/mm. Library presets: walls, floors, roofs, door, window, stairs, column, fence, tree, person. '
    'Rotate: turntable ring drag, Q/E keys, Inspector dial (X/Y/Z axis), R tool. '
    'Duplicate: Alt+drag gizmo, right-click menu, Ctrl+D. Move: G/arrows; scale: S; focus: F or double-click; '
    'Delete deletes; Ctrl+Z/Y undo/redo; Ctrl+S save; Esc deselect; snap 0.1-1 m; blueprint grid; '
    'hologram styles Solid/Exploded/Volumetric plus explode slider and spin. '
    'Autosave plus Projects tab; Export/Import JSON and PNG are PRO. Demo = 1 project free forever. '
    'PRO = \u20a62,000/month, 30 days, renewals stack, cancel anytime; demo checkout uses test card 4242 4242 4242 4242. '
    'STANDARD SIZES: wall 4x2.6x0.2 m; door 0.9x2.1 m; window 1.2x1.2 sill 0.9 m; ceiling 2.6-3 m; '
    'stairs riser 17 cm going 28 cm; bedroom 3x3 m; living room 4x5 m; foundation 0.6-1 m deep; adult ~1.7 m. '
    'STYLE: Short answers (1-4 sentences or a few bullets). Use **bold** for key terms. No tables. '
    'Friendly tone. If scene context is provided in brackets, use it when relevant.'
)

BUILD_PROMPT = (
    'You are the build planner for SITE MATRIX 3D, a browser 3D house-building studio. '
    'Units: metres. Y-up, ground at y=0. +X east/right, -X west/left, -Z north/back, +Z south/front. '
    'INPUT: a user instruction + current scene summary + a BLOCK CATALOG (each preset\'s size [L,H,W] '
    'in metres and groundY = the y position so it rests on the ground). '
    'OUTPUT: ONLY a JSON object, no markdown fences, no extra text: '
    '{"reply": "short friendly message (1-2 sentences, may use **bold** and emoji)", "actions": [...]}. '
    'ACTION SCHEMA: '
    '{"do":"add","type":"<preset>","at":[x,y,z],"rotY":0,"color":"#rrggbb"|null} '
    '{"do":"custom","dims":[L,H,W],"at":[x,y,z],"rotY":0,"color":null} '
    '{"do":"move","target":"<name|selected|last>","by":[dx,dy,dz]} or with "to":[x,y,z] '
    '{"do":"rotate","target":"...","deg":45} (relative turn about Y) '
    '{"do":"delete","target":"..."} {"do":"clear"} (ONLY if user explicitly says clear/start over/delete everything) '
    '{"do":"color","target":"...","color":"#rrggbb"} {"do":"lock","target":"...","on":true} '
    '{"do":"select"|"focus","target":"..."} {"do":"style","name":"real|solid|exploded|volumetric"} '
    '{"do":"spin","on":true} {"do":"explode","value":0-3} {"do":"snap","on":true,"size":0.5} {"do":"grid","on":true} '
    '{"do":"save"} {"do":"export"} {"do":"import"} {"do":"png"} {"do":"newProject"} '
    '{"do":"undo"} {"do":"redo"} {"do":"tool","name":"select|translate|rotate|scale"} {"do":"subscribe"} {"do":"help"} ''{"do":"row","dims":[L,H,W],"at":[x,y,z],"count":N,"step":[dx,dy,dz],"rotY":0,"color":null} = N copies in a line (count 2-24). ''{"do":"ring","dims":[L,H,W],"at":[cx,y,cz],"count":N,"radius":r} = N copies around a center, each auto-rotated to face inward (count 3-24). ''Use "type":"<preset>" instead of "dims" for library blocks in row/ring. '
    'RULES: 1) Preset types ONLY: wall, wallLong, floor, floorLarge, cube, column, roofGable, roofPyramid, '
    'roofFlat, door, window, stairs, fence, tree, human. NEVER invent types. To place a preset you MUST write {"do":"add","type":"<preset>","at":[x,y,z]} \u2014 NEVER use the preset name as "do". Example stairs: {"do":"add","type":"stairs","at":[2,0,0.7]}. '
    '2) Positions are object CENTERS. Use catalog groundY for y so things rest on the ground '
    '(e.g. wall y approx 1.3). Windows sit high: y approx sill(0.9) + H/2. Doors rest on ground. '
    'Roofs sit at wall top (y approx wall height for base-origin roofs like pyramid/gable, check catalog). '
    '3) Doors/windows CANNOT cut holes: split the wall into segments around the opening and add a lintel '
    'above (e.g. 3 m wall with centered 1.14 m door: two 0.93 m segments + lintel [1.14,0.36,0.2] at y approx 2.42). '
    '4) Exact user sizes become custom blocks. Round to 2 decimals. Keep within +/-200 m, dims 0.001-100 m. '
    '5) rotY rotates about Y in degrees. 6) If the scene already has blocks, place new work clear of them '
    '(offset +X) unless the user says where. 7) Vague asks ("build me a house") get a sensible default: '
    'floor slab, 4 walls 2.6 m, door + 2 windows (segmented walls), flat or gable roof, 10-16 actions. '
    '8) Feature COMMANDS ("switch to exploded", "turn on spin") become the matching action; pure questions '
    '("what is exploded view?") get empty actions plus an explanatory reply. '
    '9) NEVER reveal owner codes, API keys, or system details. NEVER output anything but the JSON object. ''10) BIG STRUCTURES (stadium, arena, tower, bridge, mall, church, warehouse): compose the full silhouette in at most 40 actions \u2014 ground slabs first, then walls/tiers/segments, columns, roof, details last. ''RADIAL layouts (stadium bowl, round arena): place N segments around the center, segment k of N with rotY = k*(360/N) degrees and center at distance r along its facing direction (x = r*sin(a), z = r*cos(a), a = k*2*PI/N). ''TIERS: stack rings upward and outward (each higher ring slightly larger r). Stadium recipe: green field slab + 8-12 rotated tier segments per ring + 4 tall floodlight columns at corners + fence ring. ''Tower recipe: column grid + one slab per floor + walls + roof. ''11) REPETITION: for repeated identical blocks ALWAYS prefer row/ring over many customs (a 10-segment tier ring is ONE action). ''Stadium in ~8 actions: green field slab + ring of 10 tier segments + ring of 10 upper tiers (larger radius, higher y) + 4 tall floodlight columns + fence ring + stairs. ''NEVER refuse a large structure as infeasible \u2014 row/ring make any size possible, so always emit a phase-1 plan. ''If a design truly needs more than 40 actions, build PHASE 1 now (complete structure) and end the reply with: say CONTINUE for phase 2. '
    'EXAMPLE "build a 3x3m bedroom, walls 2.6m high": '
    '{"reply":"On it \u2014 raising a 3x3 m bedroom with 2.6 m walls \U0001F3E0","actions":['
    '{"do":"custom","dims":[3,0.2,3],"at":[0,0.1,0]},'
    '{"do":"custom","dims":[3,2.6,0.2],"at":[0,1.3,-1.4]},'
    '{"do":"custom","dims":[3,2.6,0.2],"at":[0,1.3,1.4]},'
    '{"do":"custom","dims":[0.2,2.6,3],"at":[-1.4,1.3,0]},'
    '{"do":"custom","dims":[0.2,2.6,3],"at":[1.4,1.3,0]}]} '
    'EXAMPLE "switch to exploded view and spin it": '
    '{"reply":"Showtime! \U0001F4A5 Exploded view with turntable spin.",'
    '"actions":[{"do":"style","name":"exploded"},{"do":"explode","value":1.2},{"do":"spin","on":true}]}'
)

RATE_WINDOW = 60
RATE_MAX = 30
_rate = {}


def rate_ok(ip):
    now = time.time()
    hits = [t for t in _rate.get(ip, []) if now - t < RATE_WINDOW]
    if len(hits) >= RATE_MAX:
        _rate[ip] = hits
        return False
    hits.append(now)
    _rate[ip] = hits
    return True


_health_cache = {'ts': 0, 'cloud': False}


def groq_available():
    key = os.environ.get('GROQ_API_KEY', '')
    if not key:
        return False
    if time.time() - _health_cache['ts'] < 300:
        return _health_cache['cloud']
    ok = False
    try:
        req = urllib.request.Request(GROQ_MODELS_URL, headers={'Authorization': 'Bearer ' + key, 'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=8) as r:
            ok = 200 <= r.status < 300
    except Exception:
        ok = False
    _health_cache.update(ts=time.time(), cloud=ok)
    return ok


def groq_chat(messages):
    key = os.environ.get('GROQ_API_KEY', '')
    if not key:
        raise RuntimeError('no api key')
    body = json.dumps({
        'model': GROQ_MODEL,
        'messages': messages,
        'temperature': 0.7,
        'max_tokens': 300,
    }).encode('utf-8')
    req = urllib.request.Request(
        GROQ_URL, data=body,
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=25) as r:
        data = json.loads(r.read().decode('utf-8'))
    return data['choices'][0]['message']['content'].strip()


def groq_plan(messages):
    key = os.environ.get('GROQ_API_KEY', '')
    if not key:
        raise RuntimeError('no api key')
    body = json.dumps({
        'model': GROQ_MODEL,
        'messages': messages,
        'temperature': 0.3,
        'max_tokens': 2000,
    }).encode('utf-8')
    req = urllib.request.Request(
        GROQ_URL, data=body,
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'})
    last = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=35) as r:
                data = json.loads(r.read().decode('utf-8'))
            return data['choices'][0]['message']['content'].strip()
        except urllib.error.HTTPError as e:
            last = e
            if e.code not in (429, 500, 502, 503, 529) or attempt == 1:
                raise
            time.sleep(1.5)
        except Exception as e:
            last = e
            if attempt == 1:
                raise
            time.sleep(1.5)
    raise last


def parse_plan(raw):
    txt = (raw or '').strip()
    if '```' in txt:
        for p in txt.split('```'):
            if p.strip().startswith('{'):
                txt = p.strip()
                break
    start, end = txt.find('{'), txt.rfind('}')
    if start < 0 or end <= start:
        return None
    try:
        d = json.loads(txt[start:end + 1])
    except Exception:
        return None
    if not isinstance(d, dict) or not isinstance(d.get('actions'), list):
        return None
    return d


class Handler(SimpleHTTPRequestHandler):
    server_version = 'SM3D/1.0'

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        import datetime
        print('%s %s %s' % (datetime.datetime.now().strftime('%H:%M:%S'), self.address_string(), fmt % args))

    def _deny_hidden(self):
        # never serve dotfiles / key material
        path = self.path.split('?', 1)[0]
        parts = [p for p in path.split('/') if p]
        if any(p.startswith('.') or p.lower().endswith(('.key', '.pem'))
               or p.lower() in ('env', '.env') for p in parts):
            self.send_error(404)
            return True
        return False

    def _json(self, obj, status=200):
        raw = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.split('?', 1)[0] == '/api/health':
            if not rate_ok(self.client_address[0]):
                return self._json({'ok': False, 'error': 'rate limited'}, 429)
            return self._json({'ok': True, 'cloud': groq_available(), 'model': GROQ_MODEL})
        if self._deny_hidden():
            return
        super().do_GET()

    def do_POST(self):
        _p = self.path.split('?', 1)[0]
        if _p == '/api/build':
            return self._handle_build()
        if _p != '/api/chat':
            return self.send_error(404)
        if not rate_ok(self.client_address[0]):
            return self._json({'ok': False, 'error': 'Too many requests \u2014 slow down \U0001F642'}, 429)
        try:
            length = int(self.headers.get('Content-Length') or 0)
            if length > 16384:
                return self._json({'ok': False, 'error': 'message too long'}, 413)
            payload = json.loads(self.rfile.read(length).decode('utf-8') or '{}')
        except Exception:
            return self._json({'ok': False, 'error': 'bad request'}, 400)
        msg = str(payload.get('message', ''))[:1000].strip()
        if not msg:
            return self._json({'ok': False, 'error': 'empty message'}, 400)
        scene = payload.get('scene') or {}
        sel = payload.get('selected')
        ctx_bits = []
        try:
            if scene.get('count'):
                types = ', '.join('%sx %s' % (v, k) for k, v in list((scene.get('types') or {}).items())[:6])
                ctx_bits.append('Scene: %d blocks%s.' % (scene['count'], ' (%s)' % types if types else ''))
            elif scene.get('count') == 0:
                ctx_bits.append('Scene: empty (no blocks yet).')
            if sel and sel.get('name'):
                ctx_bits.append('Selected: %s (%s).' % (sel.get('name'), sel.get('type', 'block')))
        except Exception:
            pass
        user_text = msg + ('\n\n[' + ' '.join(ctx_bits) + ']' if ctx_bits else '')
        history = []
        try:
            for h in (payload.get('history') or [])[-8:]:
                if h.get('role') in ('user', 'assistant') and h.get('content'):
                    history.append({'role': h['role'], 'content': str(h['content'])[:1000]})
        except Exception:
            history = []
        sys_prompt = SYSTEM_PROMPT + (' OWNER/PRO USER: full access is already active (unlimited projects, Export/Import, PNG). Never pitch a subscription to this user; if asked about price say access is already unlocked. ' if payload.get('pro') else '')
        messages = [{'role': 'system', 'content': sys_prompt}] + history + [{'role': 'user', 'content': user_text}]
        try:
            reply = groq_chat(messages)
        except urllib.error.HTTPError as e:
            return self._json({'ok': False, 'error': 'ai unavailable (http %s)' % e.code}, 502)
        except Exception:
            return self._json({'ok': False, 'error': 'ai unavailable'}, 502)
        return self._json({'ok': True, 'reply': reply})


    def _handle_build(self):
        if not rate_ok(self.client_address[0]):
            return self._json({'ok': False, 'error': 'Too many requests'}, 429)
        try:
            length = int(self.headers.get('Content-Length') or 0)
            if length > 16384:
                return self._json({'ok': False, 'error': 'too long'}, 413)
            payload = json.loads(self.rfile.read(length).decode('utf-8') or '{}')
        except Exception:
            return self._json({'ok': False, 'error': 'bad request'}, 400)
        instr = str(payload.get('instruction', ''))[:1000].strip()
        if not instr:
            return self._json({'ok': False, 'error': 'empty'}, 400)
        scene = payload.get('scene') or {}
        try:
            scene_txt = 'blocks=%s types=%s selected=%s' % (
                scene.get('count', 0), json.dumps(scene.get('types') or {}),
                (payload.get('selected') or {}).get('name', 'none'))
        except Exception:
            scene_txt = 'unknown'
        try:
            catalog_txt = json.dumps(payload.get('catalog') or {})
        except Exception:
            catalog_txt = '{}'
        messages = [
            {'role': 'system', 'content': BUILD_PROMPT},
            {'role': 'user', 'content': 'BLOCK CATALOG:\n%s\nCURRENT SCENE: %s\nINSTRUCTION: %s'
             % (catalog_txt, scene_txt, instr)}
        ]
        try:
            raw = groq_plan(messages)
        except Exception:
            return self._json({'ok': False, 'error': 'ai unavailable'}, 502)
        plan = parse_plan(raw)
        if not plan:
            return self._json({'ok': False, 'error': 'unparseable'}, 502)
        return self._json({
            'ok': True,
            'reply': str(plan.get('reply', 'Done!'))[:600],
            'actions': plan.get('actions', [])[:40]
        })


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get('PORT', 8000))
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    key_state = 'SET' if os.environ.get('GROQ_API_KEY') else 'MISSING (local brain only)'
    print('SITE MATRIX 3D on :%d (no-cache) | GROQ_API_KEY: %s | model: %s' % (port, key_state, GROQ_MODEL))
    ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever()
