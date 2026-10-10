# CareerTrace

A student career dashboard with a roadmap that adapts instead of regenerating, mentor review across devices, realtime group chat, and a live Guide.

- **Frontend:** `public/index.html` (one file, no build step).
- **Backend:** `server.js` (Node 18+, zero dependencies). It serves the app, saves your state to `data/`, relays mentor reviews and group chat in realtime, and proxies the Guide to NVIDIA so the API key never reaches the browser.

## Run

1. Copy `.env.example` to `.env` and paste your key after `NVIDIA_API_KEY=`. Do not commit `.env` and do not share the key in chats.
2. `node server.js`  (or `npm start`)
3. Open http://localhost:3000. The header badge reads "Guide: live model" when the key works.
4. Mentor link for a second tab or another device on your network: http://YOUR-IP:3000/mentor

`npm test` runs the backend against a mock model, so it needs no key and no internet.

## What talks to the model (all server side, `server.js`)

| Route | Used for |
|---|---|
| `POST /api/guide` | Free-text chat after the plan exists: "I know pandas groupby", "become an ML engineer", "add a node for time series". Returns structured actions the page applies to the existing roadmap. |
| `POST /api/forge` | "Suggest a project" in Projects. |
| `POST /api/outreach` | "Draft note" next to a mentor (under 300 characters). |

Without a key everything still works with offline rules and built-in templates. Model name: `NVIDIA_MODEL` (default `z-ai/glm-5.3`).

## Other routes

`GET/PUT /api/state` (your data, shared across devices) | `GET/PUT /api/rv` (reviews and sign-offs; a finished one is never overwritten by a stale one) | `GET/POST /api/chat/:group` | `GET /api/events` (server-sent events) | `GET /api/health`

## Demo (about 90 seconds)

Dashboard loads a demo student. Tick roadmap items or click chips in Skills (the roadmap shrinks). Say "I want to become a data analyst" (nodes change, progress stays). Upload a repo folder (elements found with file paths as proof). Click Ask a human, open `/mentor` in another tab, flag a node and send. Accept it in the student's chat. Request sign-off, tick the rubric as the mentor, and the project is stamped Verified. Try Suggest a project, Draft note, group chat, Vertical layout and 3D tilt view.

## Known limits

- No login. Anyone who can reach the server can use the mentor link, so run it on a trusted network.
- Repo analysis is pattern matching on code. It shows usage, not mastery.
- Course links, prices, mentors and peers are demo data. Edit `CRS`, `MENT`, `PEERS` and `GRP` in `public/index.html`.
- Market numbers are labelled "Estimated, verify". Nothing is scraped.
