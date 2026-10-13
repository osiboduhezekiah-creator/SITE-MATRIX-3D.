# SITE MATRIX 3D 🏗️

A browser-based 3D building studio with hologram views and an AI building agent.
Design houses, duplexes, stadiums and more — by clicking blocks or by simply
telling the AI what to build.

## Features

- 🧱 Block library + custom sizes (m / cm / mm), snap, blueprint grid
- ✨ Hologram styles (Solid / Exploded / Volumetric), turntable spin
- 🤖 AI agent: builds, edits, paints, arranges — *"build a demo stadium"*
- 📁 Projects with thumbnails, autosave, Export/Import JSON, PNG snapshots
- 💬 Per-project chat spaces, multi-phase builds (`continue`)
- 👑 Owner mode + PRO subscriptions (₦2,000/month)

## Run locally

```bash
# GROQ_API_KEY is optional — without it the built-in local brain still works
GROQ_API_KEY=your_key_here python3 serve.py 8001
```

Then open http://localhost:8001/app.html

## Deploy to Render (free)

### 1. Put the code on GitHub

1. Go to https://github.com/new — create a repo, e.g. `site-matrix-3d` (Public or Private)
2. Upload **all files from this folder** (drag-and-drop on the repo page, or):
   ```bash
   git init
   git add .
   git commit -m "SITE MATRIX 3D"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/site-matrix-3d.git
   git push -u origin main
   ```

### 2. Create the Render service

1. Go to https://dashboard.render.com → **New → Web Service**
2. **Connect your GitHub repo** (`site-matrix-3d`) and click Connect
3. Settings (the `render.yaml` in this repo pre-fills these):
   - **Runtime:** Python 3
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `python3 serve.py $PORT`
   - **Plan:** Free (fine to start)
4. Under **Environment Variables**, add:
   - Key: `GROQ_API_KEY` — Value: your Groq API key (get one free at
     https://console.groq.com). Without it the app still runs on the local brain.
5. Click **Deploy** — wait ~2 minutes, then open your `https://site-matrix-3d.onrender.com` URL 🎉

### 3. Updating later

Just push to GitHub — Render auto-redeploys:

```bash
git add . && git commit -m "update" && git push
```

> **Note (free plan):** Render spins the service down after ~15 min of
> inactivity — the first visit after idle takes ~30–60 s to wake up.
> Your projects live in each visitor's browser (localStorage), so waking
> up loses nothing. Upgrade to Starter ($7/mo) to keep it always on.

## Owner setup (important!)

After deploying, set yourself as the lifetime admin:

1. Open `common.js`, find `ADMIN_EMAILS`, and replace
   `'owner@sitematrix3d.com'` with **your own login email**
2. Commit + push (Render redeploys automatically)
3. Log in with that email → lifetime full access, AI stops pitching PRO

Your master owner code is `MATRIX-OWNER-2026` (change it in `common.js` →
`OWNER_CODE`). Enter it via any 🔒 popup → owner link for instant unlock.

## Files

| File | Purpose |
|---|---|
| `serve.py` | Web server + Groq AI proxy (`/api/chat`, `/api/build`) |
| `app.html` / `app.js` | The 3D studio |
| `ai.js` / `ai.css` | AI agent (brain, planner, chat UI) |
| `index.html` / `landing.*` | Landing page |
| `common.js` | Auth, subscriptions, owner settings |
| `render.yaml` | Render one-click deploy config |
| `requirements.txt` | Python deps (stdlib only) |

Built with Three.js + Groq (`qwen/qwen3.8-27b`). No build step, no database.
