/* =====================================================================
   SITE MATRIX 3D — Matrix Assistant (building-only AI chat)
   - On-device assistant: no API key, no network, no cost, works offline.
   - Answers ONLY building & app questions; politely refuses everything else.
   - Scene-aware via the window.SM3D bridge (exposed at the end of app.js).
   - NEVER reveals the owner code / admin email (see 'secret' intent).
   - To plug in a real LLM later, keep aiReply()'s { text, actions } shape
     and swap the intent engine for an API call.
   ===================================================================== */

export const AI_VERSION = 'matrix-assistant v1';

/* ---------------- memory (per page load) ---------------- */
const AI_MEM = { topic: null, topicLabel: null, name: null, offCount: 0, lastBuild: null };

/* ---------------- tiny utils ---------------- */
function aiTrim(n) {
  const v = Number(n);
  if (!isFinite(v)) return '0';
  return String(parseFloat(v.toPrecision(6)));
}

function aiEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* Escape, then allow **bold** and newlines in bot replies. */
export function aiFmt(s) {
  return aiEsc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br />');
}

/* ---------------- block topics & standard sizes ---------------- */
const AI_TOPICS = {
  wall: ['wall', 'walls', 'long wall', 'partition'],
  door: ['door', 'doors', 'doorway'],
  window: ['window', 'windows'],
  stairs: ['stair', 'stairs', 'staircase', 'steps'],
  roof: ['roof', 'roofs', 'gable', 'pyramid', 'flat roof', 'pitch'],
  floor: ['floor', 'floors', 'slab', 'slabs', 'tiling', 'tiles'],
  column: ['column', 'columns', 'pillar', 'pillars', 'post'],
  fence: ['fence', 'fences', 'compound wall', 'boundary wall'],
  ceiling: ['ceiling', 'ceilings', 'headroom'],
  room: ['room', 'rooms', 'bedroom', 'living room', 'kitchen', 'bathroom', 'palour', 'parlour'],
  foundation: ['foundation', 'foundations', 'footing', 'footings', 'dpc'],
  person: ['person', 'people', 'human', 'man ', ' scale'],
  cube: ['cube', 'cubes', 'box', 'boxes', 'furniture']
};

function findTopic(t) {
  for (const id of Object.keys(AI_TOPICS)) {
    for (const kw of AI_TOPICS[id]) {
      if (t.includes(kw)) return id;
    }
  }
  return null;
}

const AI_SIZE_TEXT = {
  wall: 'A standard wall is about **4 m long × 2.6 m high × 0.2 m thick** (interior walls can be 0.1 m). In the 📐 Custom Size box just type `4 × 2.6 × 0.2` with **m** selected.',
  door: 'A standard door is **0.9 m wide × 2.1 m high**. Leave that opening in your wall, then drop the 🚪 Door block into it.',
  window: '**1.2 m wide × 1.2 m high**, with the sill (bottom edge) at **0.9 m** above the floor, is typical. Place the 🪟 Window block into your wall.',
  stairs: 'Each step: riser **~17 cm**, going (tread) **~28 cm**. For a 2.6 m floor-to-floor height you need about **15 steps**. Use the 🪜 Stairs block.',
  roof: 'Flat roof = a simple slab; a gable (🔺) sheds rain best at about **30° pitch**. Build your walls first, then drop the roof on top.',
  floor: 'A ground floor slab is **0.15–0.2 m thick**. Use Floor (4×4 m) or Big Slab and tile a few together for bigger houses.',
  column: '**0.2 × 0.2 m** columns every 3–4 m carry upper floors. The 🏛️ Column block is ready to place.',
  fence: 'Compound/boundary walls are usually **1.8–2.4 m high**. Chain 🚧 Fence blocks around your plot.',
  ceiling: 'Standard ceiling height is **2.6–3 m** — that is why the Wall preset is 2.6 m tall 🙂',
  room: 'Bedroom **3 × 3 m** minimum, living room **4 × 5 m** is comfortable, kitchen **2.5 × 3 m**. Lay Floor slabs first to mark rooms, then raise walls.',
  foundation: 'A strip foundation goes **0.6–1 m deep** and about twice as wide as the wall. In the app, start walls slightly sunk into the ground (drag down with Snap off).',
  person: 'An adult is **~1.7 m** tall — drop a 🧍 Person next to rooms and doors to judge whether everything feels right.',
  cube: 'The 📦 Cube is **1 × 1 × 1 m** — handy for furniture, steps and quick ideas.'
};

function sizeReply(topic) {
  AI_MEM.topic = topic;
  const label = topic.charAt(0).toUpperCase() + topic.slice(1);
  AI_MEM.topicLabel = label;
  const actions = topic === 'wall'
    ? [{ label: '➕ Add this 4×2.6×0.2 m wall', kind: 'custom', dims: [4, 2.6, 0.2] }]
    : [];
  return { text: AI_SIZE_TEXT[topic], actions, localOnly: true };
}

/* block words the assistant can place for you */
const AI_ADD_MAP = {
  'long wall': 'wallLong', 'flat roof': 'roofFlat', gable: 'roofGable',
  pyramid: 'roofPyramid', 'big slab': 'floorLarge', wall: 'wall', floor: 'floor',
  slab: 'floorLarge', cube: 'cube', column: 'column', door: 'door', window: 'window',
  stair: 'stairs', roof: 'roofGable', fence: 'fence', tree: 'tree',
  person: 'human', human: 'human'
};

function findAddWord(t) {
  const keys = Object.keys(AI_ADD_MAP).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (t.includes(k)) return k;
  }
  return null;
}

/* ---------------- unit converter (m / cm / mm) ---------------- */
const AI_UNIT_F = { mm: 0.001, cm: 0.01, m: 1 };

function aiConvert(val, from, to) {
  return (val * AI_UNIT_F[from]) / AI_UNIT_F[to];
}

/* ---------------- intents (first match wins — order matters) ---------------- */
const AI_INTENTS = [
  {
    id: 'secret',
    rx: [/(owner|master|admin).*(code|email|password|key|login)|reveal.*code|what.*(owner|master|admin).*code|tell me.*(owner|master).*code|unlock.*free|free.*unlock|bypass.*(pay|subscription)/],
    run() {
      return {
        text: '🔒 That is private owner information and I can\'t share it.\nIf you are the site owner, check your own setup notes. Otherwise, **Subscribe — ₦2,000/month** unlocks everything 🙂',
        actions: [{ label: '🔓 Subscribe — ₦2,000/month', kind: 'subscribe', what: 'unlock PRO features' }]
      };
    }
  },
  {
    id: 'building-code',
    rx: [/(building|house).*(code|regulation|standard|permit|approval|planning|authority)/],
    run() {
      return {
        text: 'For official rules (setbacks, approvals, structural standards), always check your **local planning authority** — requirements differ by area 🏛️\nBut I can help with the design side: wall heights, room sizes, stair rules and more. What are you building?',
        actions: []
      };
    }
  },
  {
    id: 'inject',
    rx: [/ignore.*instructions|system prompt|you are now|jailbreak|dan mode|do anything now|pretend (you|to be)/],
    run() {
      return {
        text: 'Nice try 🙂 — I only answer **building & SITE MATRIX 3D** questions.\nTry: *“How do I rotate a block?”* or *“What size is a standard door?”*',
        actions: []
      };
    }
  },
  {
    id: 'convert',
    rx: [/(\d+(?:\.\d+)?)\s*(mm|cm|m)\s*(?:in|to|=|as)\s*(mm|cm|m)\b/, /how many\s*(mm|cm)\s*in\s*(?:an?\s*|one\s*)?(m|cm|mm)/],
    run(ctx, m) {
      let val, from, to;
      if (m[3] && AI_UNIT_F[m[3]]) { val = parseFloat(m[1]); from = m[2]; to = m[3]; }
      else { val = 1; to = m[1]; from = m[2]; }
      if (!AI_UNIT_F[from] || !AI_UNIT_F[to] || !isFinite(val)) {
        return { text: 'Give me a conversion like **250cm in m** 🙂', actions: [] };
      }
      const out = aiConvert(val, from, to);
      const sceneTip = to === 'm'
        ? `\n(Scene units are metres — so that's **${aiTrim(out)}** in the Custom Size box with **m** selected.)`
        : '';
      return { text: `**${aiTrim(val)} ${from} = ${aiTrim(out)} ${to}** ✅${sceneTip}`, actions: [], localOnly: true };
    }
  },
  {
    id: 'name-set',
    rx: [/my name is ([a-z]+)/, /call me ([a-z]+)/, /i am ([a-z]+) $/],
    run(ctx, m) {
      const raw = (m[1] || '').trim();
      if (!raw || /^(a|an|the|here|new|lost|stuck|confused|fine|good|ok)$/.test(raw)) return null;
      AI_MEM.name = raw.charAt(0).toUpperCase() + raw.slice(1);
      return { text: `Nice to meet you, **${AI_MEM.name}!** 🏗️\nWhat are we building today?`, actions: [] };
    }
  },
  {
    id: 'name-get',
    rx: [/what.*my name|who am i|my name\?/],
    run() {
      return {
        text: AI_MEM.name ? `You are **${AI_MEM.name}** 🙂 — my favourite builder.` : 'You haven\'t told me your name yet 🙂 — say *"my name is …"* and I\'ll remember it.',
        actions: []
      };
    }
  },
  {
    id: 'greet',
    rx: [/^ (hi|hey|hello|yo|abeg|how far|wetin|good morning|good afternoon|good evening)\b/],
    run(ctx, m, t) {
      if (t.length > 30) return null;
      const who = AI_MEM.name ? `, ${AI_MEM.name}` : '';
      return {
        text: `Hello${who}! 👋 I'm **Matrix Assistant** — I only answer **building & SITE MATRIX 3D** questions.\nAsk me about blocks & sizes, rotating, duplicating, the hologram, saving, subscription — or your current scene.`,
        actions: []
      };
    }
  },
  { id: 'bye', rx: [/\b(bye|goodbye|good ?night|see you|later|thanks,? bye)\b/],
    run(ctx, m, t) {
      if (t.length > 35) return null;
      return { text: 'Bye 👋 — happy building! Come back any time you need a measurement or a how-to.', actions: [] };
    } },
  { id: 'thanks', rx: [/\b(thank|thanks|thx|appreciated|nice|great|perfect|awesome)\b/],
    run(ctx, m, t) {
      if (t.length > 35) return null;
      return { text: 'You\'re welcome! 🙂 Anything else you want to build or measure?', actions: [] };
    } },
  {
    id: 'capabilities',
    rx: [/(what can you do|who are you|your name|what are you|assist me|what do you know|commands|help ?$)/],
    run(ctx) {
      const pro = !!(ctx && ctx.pro);
      return {
        text: 'I\'m **Matrix Assistant** 🏗️ — your building copilot. I can:\n• Give **standard sizes** (walls, doors, windows, stairs, rooms…)\n• **Convert units** — try *“250cm in m”*\n• Teach **rotate, move, duplicate, snap & hologram** tricks\n• ' + (pro ? '**Full access is ACTIVE** 👑 — unlimited projects, Export/Import, PNG' : 'Explain **saving, export & subscription (₦2,000/month)**') + '\n• See your scene — ask *“what have I built?”*\n• Even **BUILD for you** — try *“build me a small house”*!',
        actions: [{ label: '❓ Open Help Guide', kind: 'help' }]
      };
    }
  },
  {
    id: 'start-how',
    rx: [/(getting started|how (do|can) i start|where.*(do i )?start|tutorial|beginners?|new (here|to this)|guide me|first time)/],
    run() {
      return {
        text: 'Welcome to SITE MATRIX 3D! 🏗️ Start in 3 steps:\n**1.** On the empty popup pick **Add a Wall**, **Demo House**, or **Plain Blueprint**\n**2.** Click blocks in the 🧱 library to add them, drag arrows to move\n**3.** Press **Q/E** to rotate, **Ctrl+Z** to undo anything\nAsk me anything — sizes, tools, or say *“add a wall”*!',
        actions: [{ label: '🧱 Add a Wall', kind: 'add', type: 'wall' }]
      };
    }
  },
  {
    id: 'scene-count',
    rx: [/(how many blocks|block count|count.*blocks|what.*(have i built|did i build|is on my site|is in my scene)|anything built|my (site|scene|work))/],
    run(ctx) {
      if (!ctx || !ctx.scene) return { text: 'I can\'t see your scene right now — open the studio and ask again 🙂', actions: [] };
      const n = ctx.scene.count;
      if (n === 0) {
        return {
          text: 'Your site is **empty** — a clean blueprint 🙂\nAdd a block from the library, load the demo house, start on the plain blueprint — or let me drop in a starter wall:',
          actions: [{ label: '🧱 Add a Wall', kind: 'add', type: 'wall' }]
        };
      }
      const parts = Object.entries(ctx.scene.types || {}).map(([k, v]) => `${v}× ${k}`);
      return { text: `You've built **${n} block${n === 1 ? '' : 's'}**: ${parts.join(', ')} 🏗️\nAsk *“list my blocks”* for every name.`, actions: [] };
    }
  },
  {
    id: 'scene-list',
    rx: [/(list|show|name|tell me).*(blocks|objects|everything|all)|what.*(blocks|objects).*(have|got|made)/],
    run(ctx) {
      if (!ctx || !ctx.scene) return { text: 'I can\'t see your scene right now — open the studio and ask again 🙂', actions: [] };
      const names = ctx.scene.names || [];
      if (!names.length) return { text: 'No blocks yet — your blueprint is blank 🙂 Say *“add a wall”* and I\'ll start you off!', actions: [{ label: '🧱 Add a Wall', kind: 'add', type: 'wall' }] };
      const shown = names.slice(0, 12).map((n) => `• ${n}`).join('\n');
      const more = names.length > 12 ? `\n…and ${names.length - 12} more.` : '';
      return { text: `Your **${names.length} blocks**:\n${shown}${more}`, actions: [] };
    }
  },
  {
    id: 'select-how',
    rx: [/(how.*select|select.*(block|object|multiple|all|deselect))/],
    run(ctx) {
      const cur = ctx && ctx.selected ? `\n📌 **${ctx.selected.name}** is currently selected.` : '';
      return { text: 'Click any block to **select** it — it highlights and the gizmo attaches. Click empty ground or press **Escape** to deselect.' + cur, actions: [] };
    }
  },
  {
    id: 'selected',
    rx: [/(selected|selecting|working on|current(ly)? (block|selection)|what.*(am i|is).*(selected|editing))/],
    run(ctx) {
      if (!ctx) return { text: 'I can\'t see your scene right now 🙂', actions: [] };
      if (ctx.selected) return { text: `📌 **${ctx.selected.name}** (${ctx.selected.type}) is selected.\nPress **F** to focus it, **Q/E** to rotate, or drag the gizmo arrows.`, actions: [] };
      return { text: 'Nothing is selected — **click any block** to select it 🙂', actions: [] };
    }
  },
  {
    id: 'house-guide',
    rx: [/(house|home|bungalow|duplex|floor plan|plan\b|design|start.*(build|project)|bedroom|parlour|palour)/],
    run() {
      return {
        text: 'Let\'s raise a small house 🏠\n**1.** Start on the **plain blueprint** (bare grid)\n**2.** Lay **Floor slabs** to mark rooms (bedroom 3×3 m, living room 4×5 m)\n**3.** Raise **walls 2.6 m** high around them\n**4.** Drop in a **🚪 Door (0.9×2.1 m)** and **🪟 Windows**\n**5.** Cap it with a **🔺 Gable roof**\n**6.** Add a 🧍 Person to check the scale feels right',
        actions: [
          { label: '🟫 Add Floor Slab', kind: 'add', type: 'floor' },
          { label: '🧱 Add Standard Wall', kind: 'custom', dims: [4, 2.6, 0.2] }
        ]
      };
    }
  },
  {
    id: 'add-how',
    rx: [/how.*(add|place|insert|create|put|make|build)/, /adding.*blocks.*work/],
    run(ctx, m, t) {
      const w = findAddWord(t);
      const actions = w
        ? [{ label: `➕ Add ${w.charAt(0).toUpperCase() + w.slice(1)} now`, kind: 'add', type: AI_ADD_MAP[w] }]
        : [];
      return {
        text: '**Click any block in the 🧱 library** (left dock) — it drops into your scene, selected and ready to drag. Each click offsets slightly so multiples don\'t stack.\nOr skip the clicking: just say *“add a wall”* and I\'ll place one 😎',
        actions
      };
    }
  },
  {
    id: 'add-custom-me',
    rx: [/(add|place|create|make|drop).{0,30}?(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm|cm|m)?/],
    run(ctx, m) {
      const unit = m[5] || 'm';
      const f = AI_UNIT_F[unit];
      const dims = [parseFloat(m[2]) * f, parseFloat(m[3]) * f, parseFloat(m[4]) * f].map((v) =>
        Math.min(100, Math.max(0.001, v)));
      return {
        text: `On it — adding **${m[2]} × ${m[3]} × ${m[4]} ${unit}** (≈ ${aiTrim(dims[0])} × ${aiTrim(dims[1])} × ${aiTrim(dims[2])} m) ✅`,
        actions: [],
        auto: { label: 'Add custom block', kind: 'custom', dims }
      };
    }
  },
  {
    id: 'dims-bare',
    rx: [/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(mm|cm|m)?/],
    run(ctx, m) {
      const unit = m[4] || 'm';
      const f = AI_UNIT_F[unit];
      const dims = [parseFloat(m[1]) * f, parseFloat(m[2]) * f, parseFloat(m[3]) * f];
      return {
        text: `That's **${m[1]} × ${m[2]} × ${m[3]} ${unit}** (≈ ${aiTrim(dims[0])} × ${aiTrim(dims[1])} × ${aiTrim(dims[2])} m) 📐\nType it into **📐 Custom Size Block**, or I can add it now:`,
        actions: [{ label: '➕ Add it now', kind: 'custom', dims }],
        localOnly: true
      };
    }
  },
  {
    id: 'add-me',
    rx: [/(add|place|create|make|give me|drop).{0,25}?\b(long wall|flat roof|gable|pyramid|big slab|wall|floor|slab|cube|column|door|window|stair|roof|fence|tree|person|human)\b/],
    run(ctx, m, t) {
      const word = findAddWord(t) || m[2] || 'wall';
      const type = AI_ADD_MAP[word.toLowerCase()] || 'wall';
      const label = word.charAt(0).toUpperCase() + word.slice(1);
      AI_MEM.topic = 'wall';
      AI_MEM.topicLabel = label;
      return {
        text: `Done — added a **${label}** ✅\nIt's selected: drag the arrows to move it, **Q/E** to rotate.`,
        actions: [],
        auto: { label: `Add ${label}`, kind: 'add', type }
      };
    }
  },
  {
    id: 'size-of',
    rx: [/.*/],
    run(ctx, m, t) {
      const topic = findTopic(t);
      if (topic && /(size|\bbig\b|\btall\b|\bwide\b|\bhigh\b|\blong\b|\bthick\b|dimension|measure|standard|should)/.test(t)) {
        return sizeReply(topic);
      }
      return null;
    }
  },
  {
    id: 'topic-info',
    rx: [/.*/],
    run(ctx, m, t) {
      if (/(rotat|spin|turn|move|drag|delet|remov|duplicat|copy|clone|scale|resize|select|focus|snap|add|place|create|make|build|color|colour|paint|lock|save|export|import|price|cost|pay|subscrib)/.test(t)) return null;
      const topic = findTopic(t);
      if (topic && t.trim().split(/\s+/).length <= 4) return sizeReply(topic);
      return null;
    }
  },
  {
    id: 'custom-how',
    rx: [/(custom|own size|specific size|exact size|any size|particular size|set.*(size|dimension))/],
    run() {
      return {
        text: 'Scroll to **📐 Custom Size Block** under the library → type **Length × Height × Width** → pick **m / cm / mm** → **Add Custom Block**. The green readout shows the metre equivalent live ✅\nExample: `400 × 260 × 20` in **cm** = a 4 m wall. Want one now?',
        actions: [{ label: '➕ Add 4×2.6×0.2 m wall', kind: 'custom', dims: [4, 2.6, 0.2] }]
      };
    }
  },
  {
    id: 'units-how',
    rx: [/(unit|metre|meter|centimetre|centimeter|millimetre|millimeter|\bcm\b|\bmm\b|to metre|in metre)/],
    run() {
      return {
        text: 'The 3D scene works in **metres**: **1 unit = 1 m** 📏\n• Type sizes in **m, cm or mm** in the Custom Size box — it converts for you\n• Ask me any conversion, e.g. *“250cm in m”* or *“2m in mm”*',
        actions: []
      };
    }
  },
  {
    id: 'rotate-how',
    rx: [/(rotat|spin|turn\b|angle|degree|orientation|facing|direction)/],
    run() {
      return {
        text: '4 ways to rotate a selected block 🔄\n• Drag the glowing **turntable ring** on the ground (snaps to 15° with Snap on)\n• Tap **Q / E** for quick 15° steps (5° with Snap off)\n• Use the **🔄 Turntable dial** in the Inspector for exact degrees & X/Y/Z axis\n• Press **R** for the rotate gizmo',
        actions: []
      };
    }
  },
  {
    id: 'duplicate-how',
    rx: [/(duplicat|copy|copies|clone|another one|same block|repeat)/],
    run() {
      return {
        text: '3 fast ways to duplicate ⧉\n• Hold **Alt** and **drag any gizmo** — a live copy follows your cursor\n• **Right-click** a block → **Duplicate** (menu also has Focus, +45°, Delete)\n• Select + **Ctrl+D** — instant copy in place, then drag it away',
        actions: []
      };
    }
  },
  {
    id: 'move-how',
    rx: [/(move|drag|position|place\b|shift|slide)/],
    run() {
      return {
        text: 'Select a block, then **drag the gizmo arrows** (press **G** for move mode) ↔️\n• Arrow keys / PgUp / PgDn **nudge** precisely (uses Snap size when on)\n• Turn **Snap** on to land on exact 0.1–1 m steps',
        actions: []
      };
    }
  },
  {
    id: 'scale-how',
    rx: [/(scale|resize|bigger|smaller|stretch|shrink|taller|shorter|wider|narrower)/],
    run() {
      return {
        text: 'Press **S** (or the Scale tool) and drag the gizmo cubes to resize 📦\nTip: for **exact** sizes, type numbers in the Inspector scale fields — or better, build it exact with **📐 Custom Size** in m/cm/mm from the start.',
        actions: []
      };
    }
  },
  {
    id: 'delete-how',
    rx: [/(delet|remov|erase|destroy|get rid|take (it|this|that) (out|off|away))/],
    run() {
      return {
        text: 'Select the block, then **right-click → Delete** 🗑️ — or just press **Delete / Backspace**.\nMistake? **Ctrl+Z** undoes instantly.',
        actions: []
      };
    }
  },
  {
    id: 'undo-how',
    rx: [/(undo|redo|mistake|go back|revert|oops)/],
    run() {
      return {
        text: '**Ctrl+Z** = undo, **Ctrl+Y** (or Ctrl+Shift+Z) = redo ↩️\nEvery add, move, rotate, resize and delete is a safe undo step — experiment freely!',
        actions: []
      };
    }
  },
  {
    id: 'snap-how',
    rx: [/(snap|grid|blueprint|align|precise|exactly|straight|exact position)/],
    run() {
      return {
        text: 'Precision tools 📐\n• **Snap** toggle + step size (0.1 / 0.25 / 0.5 / 1 m) — moves, rotation ring (15°) and nudge keys all obey it\n• **Show blueprint grid** — toggle the ground grid; its squares are 1 m\n• Empty site? Choose **📐 Start on Plain Blueprint** to work on the bare grid',
        actions: []
      };
    }
  },
  {
    id: 'camera-how',
    rx: [/(orbit|pan|zoom|camera|view|navigate|focus|double-click|double click|stuck|lost|cant see|can't see|disappear|find my|where is)/],
    run(ctx, m, t) {
      if (/(project|work|save|file|subscrib|pay|price|button|menu|help\b|library)/.test(t)) return null;
      return {
        text: 'Camera controls 🎥\n• **Left-drag** orbit • **Right-drag** pan • **Scroll** zoom • **Click** select\n• Lost a block? Select it and press **F** (or double-click it) to fly the camera to it 🎯',
        actions: []
      };
    }
  },
  {
    id: 'holo-how',
    rx: [/(hologram|holo|solid|exploded|volumetric|render style|scan|xyz|spin\b|auto-rotate|explode)/],
    run() {
      return {
        text: 'The Holographic Studio has 3 render styles 👻\n• **Solid** — clean realistic build\n• **Exploded** — parts float apart (drag the **explode slider**!)\n• **Volumetric** — glowing hologram with live **XYZ scan readouts**\nHit the **spin button** for a hands-free turntable rotation.',
        actions: []
      };
    }
  },
  {
    id: 'save-how',
    rx: [/(save|autosave|auto-save|project|library|thumbnail|switch|rename|new project|my work|lose)/],
    run(ctx) {
      const pro = !!(ctx && ctx.pro);
      return {
        text: 'Your work is safe 💾\n• **Autosave** runs as you build; **Ctrl+S** saves manually\n• The **Projects tab** (left dock) holds your library with thumbnails — click to switch, rename inline\n• ' + (pro ? '👑 **Full access active** — unlimited projects, everything unlocked.' : 'Demo = 1 project. **PRO (₦2,000/month)** = unlimited projects.') + '',
        actions: []
      };
    }
  },
  {
    id: 'export-how',
    rx: [/(export|import|json|png|screenshot|picture|photo|backup|download|share|send)/],
    run(ctx) {
      const pro = !!(ctx && ctx.pro);
      if (pro) return { text: 'Take your work anywhere 📤 👑 \u2014 everything is unlocked:\n\u2022 **Export** \u2014 download the project as a JSON backup file\n\u2022 **Import** \u2014 load a JSON backup back in\n\u2022 **PNG** \u2014 snap a picture of your design to share', actions: [] };
      return {
        text: 'Take your work anywhere 📤 (PRO features)\n• **Export** — download the project as a JSON backup file\n• **Import** — load a JSON backup back in\n• **PNG** — snap a picture of your design to share',
        actions: [{ label: '🔓 Subscribe — ₦2,000/month', kind: 'subscribe', what: 'use export and PNG' }]
      };
    }
  },
  {
    id: 'pricing',
    rx: [/(price|cost|how much|pay|naira|₦|2000|2,000|subscription|subscribe|renew|expir|month|cancel|billing|auto-renew)/],
    run(ctx) {
      const pro = !!(ctx && ctx.pro);
      if (pro) return { text: '👑 **Full access is already active** — unlimited projects, Export/Import, PNG and the whole library. Nothing to pay — what shall we build?', actions: [] };
      return {
        text: '**Full Access = ₦2,000/month** 💰 — 30 days of unlimited projects, Export/Import, PNG and your full library.\n• Renew anytime to extend (early renewals stack — no lost days)\n• Expired? Projects stay safe; renew to unlock again\n• Cancel anytime',
        actions: [{ label: '🔓 Subscribe — ₦2,000/month', kind: 'subscribe', what: 'unlock PRO features' }]
      };
    }
  },
  {
    id: 'checkout-how',
    rx: [/(card|checkout|paystack|flutterwave|test card|payment)/],
    run() {
      return {
        text: 'Pay by card in the secure in-app checkout 💳 — this demo build simulates it, so use test card **4242 4242 4242 4242** (no real charge).\nLive Paystack/Flutterwave billing plugs into the same flow later.',
        actions: []
      };
    }
  },
  {
    id: 'demo-pro',
    rx: [/(demo|free|limit|pro\b|full access|locked|upgrade)/],
    run(ctx) {
      const pro = !!(ctx && ctx.pro);
      if (pro) return { text: '👑 **Full access is already active** on this account — unlimited projects, Export/Import, PNG and the full library. Nothing is locked — what shall we build?', actions: [] };
      return {
        text: '**Demo (free forever):** 1 sandbox project with every building tool + all 3 hologram modes.\n**PRO (₦2,000/month):** unlimited projects, project library, Export/Import, PNG screenshots.\nAnything with 🔒 just needs a subscription 🙂',
        actions: [{ label: '🔓 Subscribe — ₦2,000/month', kind: 'subscribe', what: 'unlock PRO features' }]
      };
    }
  },
  {
    id: 'color-how',
    rx: [/(color|colour|paint|repaint)/],
    run() {
      return {
        text: 'Select a block, then use the **color picker in the Inspector** (right panel) 🎨 — it repaints instantly and saves with the project.',
        actions: []
      };
    }
  },
  {
    id: 'lock-how',
    rx: [/(lock|unlock|protect).*(block|object|move|accident)|prevent.*mov/],
    run() {
      return {
        text: 'Select a block and tick **🔒 Locked in the Inspector** — it can\'t be moved, scaled or duplicated until you untick it. Great for finished walls while you work around them.',
        actions: []
      };
    }
  },
  {
    id: 'troubleshoot',
    rx: [/(not working|isn't working|doesn.*work|broken|bug|error|problem|issue|confused|help me)/],
    run() {
      return {
        text: 'Let\'s fix it 🔧\n• Block won\'t move? It may be **🔒 locked** (Inspector) — untick it\n• Button locked (🔒)? That\'s a **PRO** feature — Subscribe\n• Lost your work? Check the **Projects tab** — autosave keeps it\n• Still stuck? Tell me exactly what you clicked and what happened 👇',
        actions: []
      };
    }
  },
  {
    id: 'contact-human',
    rx: [/(owner|admin|contact|support|human|real person|phone|email|whatsapp|talk to someone)/],
    run() {
      return {
        text: 'I\'m the built-in assistant and I can handle most building & app questions right here 🙂\nI can\'t share the owner\'s private contact details — but ask me anything about blocks, sizes, tools or subscription and I\'ll sort you out.',
        actions: []
      };
    }
  },
  {
    id: 'offtopic',
    rx: [/(joke|funny|laugh|weather|\brain\b|sunny|politic|president|election|governor|football|soccer|bet9ja|music|song|lyrics|movie|film|actor|code\b|python|javascript|program|homework|assignment|\bexams?\b|religion|bible|quran|church|mosque|recipe|cook|food|health|doctor|sick|hospital|love|dating|relationship|married|money|forex|crypto|bitcoin|bet\b|gamble|game|gaming|news|\bsports?\b)/],
    run() {
      AI_MEM.offCount += 1;
      const a = AI_OFF_EXAMPLES[AI_MEM.offCount % AI_OFF_EXAMPLES.length];
      const b = AI_OFF_EXAMPLES[(AI_MEM.offCount + 2) % AI_OFF_EXAMPLES.length];
      return {
        text: `I'm the SITE MATRIX 3D building assistant — I only answer **building & app** questions 🙂\nTry: *“${a}”* or *“${b}”*`,
        actions: []
      };
    }
  }
];

const AI_OFF_EXAMPLES = [
  'How do I rotate a block?',
  'What size is a standard door?',
  '250cm in m?',
  'How much is PRO?',
  'What have I built?',
  'How do I build a house?'
];

const BUILD_KEYS = [
  'block', 'wall', 'floor', 'roof', 'door', 'window', 'stair', 'column',
  'fence', 'cube', 'slab', 'found', 'concrete', 'cement', 'sand', 'brick',
  'build', 'construct', 'house', 'home', 'room', 'bedroom', 'kitchen',
  'meter', 'metre', 'cm', 'mm', 'inch', 'feet', 'foot', 'size', 'tall',
  'wide', 'high', 'long', 'thick', 'dimension', 'scale', 'measure',
  'rotat', 'spin', 'turn', 'move', 'drag', 'snap', 'grid', 'blueprint',
  'hologram', 'holo', 'solid', 'exploded', 'volumetric', 'scan',
  'save', 'export', 'import', 'png', 'project', 'subscrib', 'price',
  'pro', 'demo', 'app', 'studio', '3d', 'design', 'plan', 'architect',
  'beam', 'lintel', 'plumb', 'electric', 'wire', 'wiring', 'drain',
  'ceiling', 'veranda', 'balcony', 'gate', 'compound', 'plot', 'land'
];

/* ---------------- main engine ----------------
   ctx = { scene: { count, types, names }, selected: {name,type}|null } | null */
export function aiReply(raw, ctx) {
  const clean = String(raw || '').trim();
  if (!clean) {
    return { text: 'Go ahead — ask me anything about **building** 🏗️ (sizes, tools, subscription…).', actions: [] };
  }
  let t = ' ' + clean.toLowerCase() + ' ';
  if (AI_MEM.topicLabel) {
    const lbl = AI_MEM.topicLabel.toLowerCase();
    t = t.replace(/\bthat one\b/g, lbl).replace(/\bit\b/g, lbl);
  }
  for (const intent of AI_INTENTS) {
    for (const rx of intent.rx) {
      const m = t.match(rx);
      if (m) {
        const out = intent.run(ctx, m, t);
        if (out) return out;
      }
    }
  }
  const looksBuilding = BUILD_KEYS.some((k) => t.includes(k));
  if (looksBuilding) {
    return {
      text: 'I want to help with that building question 🏗️ — I know about **blocks & standard sizes**, **m/cm/mm converting**, **rotating / moving / duplicating**, **hologram & snap**, **saving & subscription**, and your current scene.\nCould you rephrase it a little?',
      actions: []
    };
  }
  AI_MEM.offCount += 1;
  const a = AI_OFF_EXAMPLES[AI_MEM.offCount % AI_OFF_EXAMPLES.length];
  const b = AI_OFF_EXAMPLES[(AI_MEM.offCount + 2) % AI_OFF_EXAMPLES.length];
  return {
    text: `I'm the SITE MATRIX 3D building assistant — I only answer **building & app** questions 🙂\nTry: *“${a}”* or *“${b}”*`,
    actions: []
  };
}

/* ================= chat UI (browser only) ================= */
const AI_CHIPS = [
  '🏘️ Build a demo duplex',
  '📏 Standard wall size',
  '🔄 How do I rotate?',
  '💰 How much is PRO?',
  '🏠 How do I build a house?',
  '📦 What have I built?',
  '➕ Add a standard wall',
  '🏠 Build me a small house'
];

function aiGreeting() {
  const who = AI_MEM.name ? `, ${AI_MEM.name}` : '';
  let PROLINE = '';
  try { const _B = (typeof window !== 'undefined' && window.SM3D) || null; if (_B && _B.isPro && _B.isPro()) PROLINE = '\n👑 **Owner/PRO mode** — every tool is unlocked. Just tell me what to build!'; } catch (e) {}
  return `👋 Hi${who}! I'm **Matrix Assistant** 🤖 — your **building agent**.\nTell me what to build — *“build a duplex”*, *“add a door on the front wall”*, *“paint it blue”* — and I'll construct it **directly on your blueprint**, step by step.\nI only answer **building & SITE MATRIX 3D** questions: blocks & sizes, rotating, the hologram, saving, subscription — or your scene.${PROLINE}`;
}

function aiGetCtx() {
  try {
    const B = (typeof window !== 'undefined' && window.SM3D) || null;
    if (!B) return null;
    return { scene: B.scene(), selected: B.selected(), pro: !!(B.isPro && B.isPro()) };
  } catch (e) { return null; }
}

/* -------- Groq cloud layer (local brain stays as automatic fallback) -------- */
let AI_CLOUD = false;
const AI_HIST = [];
let AI_PID = null;
const AI_CHATS = {};
let AI_CHATLOG = [];
let AI_RESTORING = false;

export function aiChatSnapshot() {
  return { log: AI_CHATLOG, hist: AI_HIST.slice(), topic: AI_MEM.topic, topicLabel: AI_MEM.topicLabel, lastBuild: AI_MEM.lastBuild };
}
export function aiChatRestoreData(saved) {
  AI_CHATLOG = saved && Array.isArray(saved.log) ? saved.log : [];
  AI_HIST.length = 0;
  if (saved && Array.isArray(saved.hist)) saved.hist.forEach((h) => AI_HIST.push(h));
  AI_MEM.topic = saved ? saved.topic : null;
  AI_MEM.topicLabel = saved ? saved.topicLabel : null;
  AI_MEM.lastBuild = saved ? saved.lastBuild : null;
}

async function aiCheckCloud() {
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    const j = await r.json();
    AI_CLOUD = !!(j && j.cloud);
  } catch (e) { AI_CLOUD = false; }
  const sub = document.getElementById('ai-sub');
  if (sub) sub.textContent = AI_CLOUD ? '● online • Groq AI ⚡' : '● online • built-in brain';
}

function aiCloudActions(t) {
  const out = [];
  const w = findAddWord(t);
  if (w && /(add|place|create|make|drop|build|need|want|give)/.test(t)) {
    const label = w.charAt(0).toUpperCase() + w.slice(1);
    out.push({ label: '➕ Add ' + label, kind: 'add', type: AI_ADD_MAP[w] });
  }
  if (/(subscrib|price|cost|how much|pay|₦|pro\b|export|png)/.test(t)) {
    out.push({ label: '🔓 Subscribe — ₦2,000/month', kind: 'subscribe', what: 'unlock PRO features' });
  }
  if (/(help|guide|tutorial)/.test(t)) out.push({ label: '❓ Open Help Guide', kind: 'help' });
  return out.slice(0, 3);
}

async function aiCloudReply(text, ctx) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        scene: ctx && ctx.scene ? { count: ctx.scene.count, types: ctx.scene.types, names: (ctx.scene.names || []).slice(0, 20) } : null,
        selected: (ctx && ctx.selected) || null,
        pro: !!(ctx && ctx.pro),
        history: AI_HIST.slice(-8)
      }),
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j || !j.reply) throw new Error('empty');
    AI_HIST.push({ role: 'user', content: text.slice(0, 1000) });
    AI_HIST.push({ role: 'assistant', content: String(j.reply).slice(0, 1000) });
    while (AI_HIST.length > 8) AI_HIST.shift();
    return j.reply;
  } finally {
    clearTimeout(timer);
  }
}

function initAI() {
  if (document.getElementById('ai-fab')) return;

  const fab = document.createElement('button');
  fab.id = 'ai-fab';
  fab.title = 'Chat with Matrix Assistant (building questions only)';
  fab.textContent = '💬';
  document.body.appendChild(fab);

  const panel = document.createElement('div');
  panel.id = 'ai-panel';
  panel.className = 'hidden';
  panel.innerHTML =
    '<div id="ai-head">' +
      '<div id="ai-avatar">🏗️</div>' +
      '<div id="ai-titles"><div id="ai-name">Matrix Assistant</div>' +
      '<div id="ai-sub">● online • 🤖 agent mode — tell me what to build</div></div>' +
      '<button id="ai-clear" title="Clear chat">🗑</button>' +
      '<button id="ai-close" title="Close">✕</button>' +
    '</div>' +
    '<div id="ai-msgs"></div>' +
    '<div id="ai-chips"></div>' +
    '<form id="ai-form"><input id="ai-input" type="text" placeholder="Tell me what to build, or ask anything…" autocomplete="off" maxlength="300" />' +
    '<button id="ai-send" type="submit" title="Send">➤</button></form>';
  document.body.appendChild(panel);

  aiCheckCloud();
  const msgs = panel.querySelector('#ai-msgs');
  const input = panel.querySelector('#ai-input');
  let greeted = false;

  function scrollDown() { msgs.scrollTop = msgs.scrollHeight; }

  function runAction(a, btn) {
    const B = (typeof window !== 'undefined' && window.SM3D) || null;
    if (!B) return 'I can\'t reach the studio right now 😕';
    try {
      if (a.kind === 'add' && a.type) { B.addBlock(a.type); return null; }
      if (a.kind === 'custom' && a.dims) { B.addCustom(a.dims[0], a.dims[1], a.dims[2]); return null; }
      if (a.kind === 'help') { B.help(); return 'Opening the Help Guide ❓'; }
      if (a.kind === 'subscribe') { if (B.isPro && B.isPro()) return '👑 Full access is already active — everything is unlocked.'; B.subscribe(a.what); return null; }
    } catch (e) { return 'Hmm, that didn\'t work 😕 — try it from the toolbar instead.'; }
    return null;
  }

  function pushBot(text, actions, auto, nolog) {
    const div = document.createElement('div');
    div.className = 'ai-msg ai-bot';
    div.innerHTML = aiFmt(text);
    if (!nolog && !AI_RESTORING) AI_CHATLOG.push({ who: 'b', text: String(text), actions: Array.isArray(actions) ? actions : [] });
    if (actions && actions.length) {
      const wrap = document.createElement('div');
      wrap.className = 'ai-actions';
      actions.forEach((a) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ai-act';
        b.textContent = a.label;
        b.addEventListener('click', () => {
          b.disabled = true;
          const note = runAction(a, b);
          pushUser(a.label);
          if (note) pushBot(note, [], null);
        });
        wrap.appendChild(b);
      });
      div.appendChild(wrap);
    }
    msgs.appendChild(div);
    scrollDown();
    if (auto) {
      const note = runAction(auto, null);
      if (note) pushBot(note, [], null);
    }
    return div;
  }

  function pushUser(text) {
    const div = document.createElement('div');
    div.className = 'ai-msg ai-user';
    div.textContent = text;
    msgs.appendChild(div);
    scrollDown();
    if (!AI_RESTORING) AI_CHATLOG.push({ who: 'u', text: String(text) });
  }

  function send(text) {
    const clean = String(text || '').trim();
    if (!clean) return;
    pushUser(clean);
    input.value = '';
    const typing = document.createElement('div');
    typing.className = 'ai-msg ai-bot ai-typing';
    typing.innerHTML = '<span></span><span></span><span></span>';
    msgs.appendChild(typing);
    scrollDown();
    setTimeout(async () => {
      const ctx = aiGetCtx();
      let local = null;
      try { local = aiReply(clean, ctx); } catch (e) { local = null; }
      // scene commands (add/place blocks) always run locally: instant + reliable
      if (local && local.auto) {
        typing.remove();
        pushBot(local.text, local.actions, local.auto);
        return;
      }
      if (local && local.localOnly) {
        typing.remove();
        pushBot(local.text, local.actions, null);
        return;
      }
      const wantBuild = aiShouldBuild(clean) || aiIsContinue(clean);
      if (AI_CLOUD && wantBuild) {
        const isCont = !aiShouldBuild(clean) && aiIsContinue(clean);
        const instruction = isCont
          ? 'CONTINUE phase ' + (AI_MEM.lastBuild.phase + 1) + ' of: ' + AI_MEM.lastBuild.instruction + ' (earlier phases already built \u2014 place new work clear of existing blocks)'
          : clean;
        try {
          const plan = await aiBuildPlan(instruction, ctx);
          AI_MEM.lastBuild = { instruction: isCont ? AI_MEM.lastBuild.instruction : clean, phase: isCont ? AI_MEM.lastBuild.phase + 1 : 1 };
          typing.remove();
          await runPlan(plan.actions, plan.reply, pushBot);
          return;
        } catch (e) { /* fall through to builder-unavailable notice below */ }
        typing.remove();
        pushBot('🔨 The builder hit a temporary AI hiccup and came back empty-handed — your scene is safe. Wait a few seconds and ask again (e.g. *“build a demo stadium”*), and I will raise it for you. I never give up on big structures 💪', [], null);
        return;
      }
      if (AI_CLOUD) {
        try {
          const reply = await aiCloudReply(clean, ctx);
          typing.remove();
          pushBot(reply, aiCloudActions(' ' + clean.toLowerCase() + ' '), null);
          return;
        } catch (e) { /* fall through to local brain */ }
      }
      typing.remove();
      if (local) pushBot(local.text, local.actions, local.auto);
      else pushBot('Hmm, I glitched for a second 😅 — ask me again?', [], null);
    }, 450 + Math.min(700, clean.length * 6));
  }

  function greet() {
    if (!AI_PID) { try { const _B = window.SM3D; if (_B && _B.projectId) AI_PID = _B.projectId() || null; } catch (e) {} }
    pushBot(aiGreeting(), [], null);
  }

  window.AI_ON_PROJECT = function (pid) {
    try {
      if (AI_PID) AI_CHATS[AI_PID] = aiChatSnapshot();
      AI_PID = pid;
      const saved = (pid && AI_CHATS[pid]) || null;
      aiChatRestoreData(saved);
      msgs.innerHTML = '';
      if (!saved || !saved.log.length) { greet(); return; }
      AI_RESTORING = true;
      try {
        saved.log.forEach((e) => {
          if (e.who === 'u') pushUser(e.text);
          else pushBot(e.text, e.actions || [], null);
        });
      } finally { AI_RESTORING = false; }
      scrollDown();
    } catch (e) { /* chat restore must never break project switching */ }
  };

  function toggle(open) {
    const willOpen = open !== undefined ? open : panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willOpen);
    fab.textContent = willOpen ? '✕' : '💬';
    if (willOpen) {
      if (!greeted) { greeted = true; greet(); }
      setTimeout(() => input.focus(), 60);
    }
  }

  fab.addEventListener('click', () => toggle());
  panel.querySelector('#ai-close').addEventListener('click', () => toggle(false));
  panel.querySelector('#ai-clear').addEventListener('click', () => {
    msgs.innerHTML = '';
    AI_HIST.length = 0;
    AI_MEM.topic = null;
    AI_MEM.topicLabel = null;
    AI_MEM.lastBuild = null;
    AI_CHATLOG = [];
    if (AI_PID) delete AI_CHATS[AI_PID];
    greet();
  });
  panel.querySelector('#ai-form').addEventListener('submit', (e) => {
    e.preventDefault();
    send(input.value);
  });

  const chips = panel.querySelector('#ai-chips');
  AI_CHIPS.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ai-chip';
    b.textContent = c;
    b.addEventListener('click', () => send(c.replace(/^[^\s]+\s/, '')));
    chips.appendChild(b);
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAI);
  else initAI();
}

/* ================= AI builder: router, validator, planner, runner ================= */

export function aiIsContinue(raw) {
  if (!AI_MEM.lastBuild) return false;
  return /^(continue|go on|keep going|keep building|next phase|phase \d+|finish it)\b/i.test(String(raw || '').trim());
}

export function aiShouldBuild(raw) {
  const s = String(raw || '').trim().replace(/^please\s+/i, '');
  if (/^(can you|could you|would you)\b/i.test(s) && /(build|make|create|add|place|put|design)/i.test(s)) return true;
  if (/^(i want|i need|give me|get me|make me)\b/i.test(s) &&
      (findAddWord(' ' + s.toLowerCase() + ' ') || /(room|house|build|design|size|wall|fence|garage)/i.test(s))) return true;
  if (/^(how|what|why|when|where|which|who|is|are|do|does|can|should)\b/i.test(s)) return false;
  if (/^(build|make|create|construct|add|place|put|drop|lay|raise|erect|move|shift|slide|push|pull|rotate|turn|spin|delete|remove|demolish|erase|clear|start over|arrange|line|change|paint|repaint|color|enlarge|shrink|extend|stretch|switch|set|turn on|turn off|enable|disable|open|show|hide|save|export|import|download|share|undo|redo|subscribe|upgrade|help)\b/i.test(s)) return true;
  if (/^(bedroom|house|room|garage|bungalow|duplex|fence|wall|kitchen|bathroom|toilet|shop|office|church|mosque|school|gate|shed)\b/i.test(s)) return true;
  return false;
}

const AI_PLAN_TYPES = ['wall', 'wallLong', 'floor', 'floorLarge', 'cube', 'column', 'roofGable', 'roofPyramid', 'roofFlat', 'door', 'window', 'stairs', 'fence', 'tree', 'human'];
const AI_PLAN_STYLES = ['real', 'solid', 'exploded', 'volumetric'];
const AI_PLAN_TOOLS = ['select', 'translate', 'rotate', 'scale'];

function aiCleanColor(v) {
  return (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim())) ? v.trim().toLowerCase() : null;
}

export function aiValidatePlan(actions) {
  if (!Array.isArray(actions)) return [];
  const out = [];
  const num = (v, lo, hi, fb) => { v = Number(v); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb; };
  const vec3 = (v, lo, hi) => (Array.isArray(v) ? [num(v[0], lo, hi, 0), num(v[1], lo, hi, 0), num(v[2], lo, hi, 0)] : null);
  const tgt = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : 'selected');
  const KNOWN_DO = ['add', 'custom', 'row', 'ring', 'move', 'rotate', 'delete', 'clear', 'color', 'lock', 'select', 'focus', 'style', 'spin', 'explode', 'snap', 'grid', 'save', 'export', 'import', 'png', 'newProject', 'undo', 'redo', 'tool', 'subscribe', 'help'];
  for (let raw of actions.slice(0, 40)) {
    if (!raw || typeof raw.do !== 'string') continue;
    // leniency: planner sometimes emits the preset as "do" — normalize to add
    if (!KNOWN_DO.includes(raw.do) && AI_PLAN_TYPES.includes(raw.do)) {
      raw = { do: 'add', type: raw.do, at: raw.at, rotY: raw.rotY, color: raw.color };
    }
    const a = { do: raw.do };
    switch (raw.do) {
      case 'add':
        if (!AI_PLAN_TYPES.includes(raw.type)) continue;
        a.type = raw.type;
        a.at = Array.isArray(raw.at) ? vec3(raw.at, -200, 200) : null;
        a.rotY = num(raw.rotY, -360, 360, 0);
        a.color = aiCleanColor(raw.color);
        break;
      case 'custom': {
        a.dims = (vec3(raw.dims, 0.001, 100) || [1, 1, 1]).map((v) => (v > 0 ? v : 1));
        a.at = Array.isArray(raw.at) ? vec3(raw.at, -200, 200) : null;
        a.rotY = num(raw.rotY, -360, 360, 0);
        a.color = aiCleanColor(raw.color);
        break;
      }
      case 'move':
        a.target = tgt(raw.target);
        if (Array.isArray(raw.to)) a.to = vec3(raw.to, -200, 200);
        else if (Array.isArray(raw.by)) a.by = vec3(raw.by, -200, 200);
        else continue;
        break;
      case 'rotate':
        a.target = tgt(raw.target);
        a.deg = num(raw.deg, -360, 360, 0);
        break;
      case 'delete':
      case 'select':
      case 'focus':
        a.target = tgt(raw.target);
        break;
      case 'clear':
      case 'save':
      case 'export':
      case 'import':
      case 'png':
      case 'newProject':
      case 'undo':
      case 'redo':
      case 'help':
        break;
      case 'color':
        a.target = tgt(raw.target);
        a.color = aiCleanColor(raw.color);
        if (!a.color) continue;
        break;
      case 'lock':
        a.target = tgt(raw.target);
        a.on = raw.on !== false;
        break;
      case 'style':
        if (!AI_PLAN_STYLES.includes(raw.name)) continue;
        a.name = raw.name;
        break;
      case 'spin':
      case 'grid':
        a.on = raw.on !== false;
        break;
      case 'explode':
        a.value = num(raw.value, 0, 3, 1);
        break;
      case 'snap':
        a.on = raw.on !== false;
        if (raw.size !== undefined) a.size = num(raw.size, 0.05, 2, 0.5);
        break;
      case 'tool':
        if (!AI_PLAN_TOOLS.includes(raw.name)) continue;
        a.name = raw.name;
        break;
      case 'subscribe':
        a.what = (typeof raw.what === 'string' && raw.what.trim() ? raw.what.trim() : 'unlock PRO features').slice(0, 80);
        break;
      case 'row':
      case 'ring': {
        if (typeof raw.type === 'string' && AI_PLAN_TYPES.includes(raw.type)) a.type = raw.type;
        else if (Array.isArray(raw.dims)) a.dims = (vec3(raw.dims, 0.001, 100) || [1, 1, 1]).map((v) => (v > 0 ? v : 1));
        else continue;
        if (!Array.isArray(raw.at)) continue;
        a.at = vec3(raw.at, -200, 200);
        a.count = Math.round(num(raw.count, 2, 24, 4));
        if (a.do === 'row') {
          if (!Array.isArray(raw.step)) continue;
          a.step = vec3(raw.step, -200, 200) || [2, 0, 0];
        } else {
          a.radius = num(raw.radius, 0.5, 200, 8);
          if (a.count < 3) a.count = 3;
        }
        a.rotY = num(raw.rotY, -360, 360, 0);
        a.color = aiCleanColor(raw.color);
        break;
      }
      default:
        continue;
    }
    out.push(a);
  }
  return out;
}

async function aiBuildPlan(text, ctx, _retry) {
  const B = (typeof window !== 'undefined' && window.SM3D) || null;
  try {
    return await aiBuildPlanOnce(text, ctx, B);
  } catch (e) {
    if (!_retry) {
      await new Promise((r) => setTimeout(r, 1500));
      return aiBuildPlan(text, ctx, true);
    }
    throw e;
  }
}

async function aiBuildPlanOnce(text, ctx, B) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const r = await fetch('/api/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instruction: text,
        scene: ctx && ctx.scene ? { count: ctx.scene.count, types: ctx.scene.types } : null,
        selected: (ctx && ctx.selected) || null,
        catalog: (B && B.catalog) ? B.catalog() : {}
      }),
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j || !j.ok || !Array.isArray(j.actions)) throw new Error('bad plan');
    return { reply: j.reply || 'Done!', actions: j.actions };
  } finally {
    clearTimeout(timer);
  }
}

function runPlanAction(a) {
  const B = window.SM3D;
  switch (a.do) {
    case 'add': return a.at ? B.addAt(a.type, a.at[0], a.at[1], a.at[2], a.rotY || 0, a.color || null)
      : B.addAt(a.type, null, 0, 0, 0, a.color || null);
    case 'custom': return a.at ? B.customAt(a.dims[0], a.dims[1], a.dims[2], a.at[0], a.at[1], a.at[2], a.rotY || 0, a.color || null)
      : B.customAt(a.dims[0], a.dims[1], a.dims[2], null, 0, 0, 0, a.color || null);
    case 'move': return a.to ? B.moveTo(a.target, a.to[0], a.to[1], a.to[2]) : B.moveBy(a.target, a.by[0], a.by[1], a.by[2]);
    case 'rotate': return B.turnBy(a.target, a.deg || 0);
    case 'delete': return B.removeTarget(a.target);
    case 'clear': B.clearAll(); return 'cleared';
    case 'color': return B.setColor(a.target, a.color);
    case 'lock': return B.setLocked(a.target, a.on !== false);
    case 'select': return B.selectTarget(a.target);
    case 'focus': return B.focusTarget(a.target);
    case 'style': return B.setStyle(a.name);
    case 'spin': return B.setSpin(a.on !== false);
    case 'explode': return B.setExplode(a.value);
    case 'snap': return B.setSnap(a.on !== false, a.size);
    case 'grid': return B.setGrid(a.on !== false);
    case 'save': return B.saveNow();
    case 'export': return B.exportNow();
    case 'import': return B.importNow();
    case 'png': return B.pngNow();
    case 'newProject': return B.newProjectNow();
    case 'undo': return B.undoNow();
    case 'redo': return B.redoNow();
    case 'tool': return B.setToolNow(a.name);
    case 'subscribe': return B.subscribe(a.what || 'unlock PRO features');
    case 'row': {
      let n = 0;
      for (let i = 0; i < a.count; i++) {
        try {
          const px = a.at[0] + a.step[0] * i, py = a.at[1] + a.step[1] * i, pz = a.at[2] + a.step[2] * i;
          if (a.type) B.addAt(a.type, px, py, pz, a.rotY || 0, a.color || null);
          else B.customAt(a.dims[0], a.dims[1], a.dims[2], px, py, pz, a.rotY || 0, a.color || null);
          n++;
        } catch (e) { /* keep placing the rest */ }
      }
      return n;
    }
    case 'ring': {
      let n = 0;
      for (let i = 0; i < a.count; i++) {
        try {
          const ang = (i * 360) / a.count + (a.rotY || 0);
          const rad = (ang * Math.PI) / 180;
          const px = a.at[0] + a.radius * Math.sin(rad), pz = a.at[2] + a.radius * Math.cos(rad);
          if (a.type) B.addAt(a.type, px, a.at[1], pz, ang + 180, a.color || null);
          else B.customAt(a.dims[0], a.dims[1], a.dims[2], px, a.at[1], pz, ang + 180, a.color || null);
          n++;
        } catch (e) { /* keep placing the rest */ }
      }
      return n;
    }
    case 'help': return B.help();
    default: return null;
  }
}

async function runPlan(actions, reply, pushBot) {
  const B = (typeof window !== 'undefined' && window.SM3D) || null;
  if (!B) { pushBot('I can\'t reach the studio right now 😕', [], null); return; }
  const valid = aiValidatePlan(actions);
  if (!valid.length) {
    pushBot((reply || 'Done!') + '\n\n(I couldn\'t turn that into safe steps — try rephrasing it 👇)', [], null);
    return;
  }
  if (valid.some((a) => a.do === 'clear')) {
    let ok = false;
    try { ok = window.confirm('The AI wants to clear your whole scene. Continue?'); } catch (e) { ok = false; }
    if (!ok) { pushBot('Kept your scene — nothing cleared 🙂', [], null); return; }
  }
  const MUT = ['add', 'custom', 'row', 'ring', 'move', 'rotate', 'delete', 'clear', 'color', 'lock'];
  const NO_BATCH = ['undo', 'redo', 'newProject'];
  const useBatch = valid.some((a) => MUT.includes(a.do)) && !valid.some((a) => NO_BATCH.includes(a.do));
  const showProgress = valid.length > 2;
  const progressEl = showProgress ? pushBot('🔨 Working on it\u2026', [], null, true) : null;
  if (useBatch) B.beginBatch();
  let done = 0, failed = 0;
  for (const a of valid) {
    try {
      const r = runPlanAction(a);
      if (r !== null && r !== undefined && r !== false) done++;
      else failed++;
    } catch (e) { failed++; }
    if (progressEl) {
      progressEl.innerHTML = aiFmt(`🔨 Building\u2026 **${done + failed}/${valid.length}**`);
      await new Promise((r) => setTimeout(r, 140));
    }
  }
  if (useBatch) B.endBatch(); else B.sync();
  if (progressEl) progressEl.remove();
  pushBot((reply || 'Done!') + `\n\n✅ Executed **${done} step${done === 1 ? '' : 's'}**${failed ? ` (${failed} skipped)` : ''} — one Undo (Ctrl+Z) reverses it all.`, [], null);
}
