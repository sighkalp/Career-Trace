// CareerTrace backend: static files, JSON persistence, realtime (SSE), and the Guide proxy to NVIDIA.
// Zero dependencies. Node 18+. The API key lives in .env and never reaches the browser.
const http = require("http"),
  fs = require("fs"),
  path = require("path");
const { MongoClient } = require('mongodb');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
try {
  for (const l of fs
    .readFileSync(path.join(__dirname, ".env"), "utf8")
    .split("\n")) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m)
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch (e) {}

const JWT_SECRET = process.env.JWT_SECRET || 'careertrace_secret_mvp';
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
let db, usersCol, stateCol, rvCol, chatCol;
MongoClient.connect(MONGO_URI).then(c => {
  db = c.db('careertrace');
  usersCol = db.collection('users'); stateCol = db.collection('state');
  rvCol = db.collection('rv'); chatCol = db.collection('chat');
  console.log('MongoDB Connected');
}).catch(e => console.error('DB Error', e));
// env parsing moved above
const KEY = process.env.NVIDIA_API_KEY,
  MODEL = process.env.NVIDIA_MODEL || "z-ai/glm-5.3";
const BASE = (
  process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1"
).replace(/\/$/, "");
const PORT = +process.env.PORT || 3000,
  HOST = process.env.HOST || "0.0.0.0";
// File persistence removed in favor of MongoDB
const clients = new Set(),
  emit = (ev, d) => {
    for (const r of clients)
      r.write(`event: ${ev}\ndata: ${JSON.stringify(d || {})}\n\n`);
  };
const rank = (e) =>
  e && (e.status === "answered" || e.status === "done") ? 1 : 0;
const send = (res, c, o) => {
  res.writeHead(c, { "Content-Type": "application/json" });
  res.end(JSON.stringify(o));
};
const body = async (req) => {
  let b = "";
  for await (const c of req) {
    b += c;
    if (b.length > 1.5e6) throw new Error("body too large");
  }
  return b ? JSON.parse(b) : {};
};
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const SYS = {
  guide: `You are Guide, the career-planning assistant inside CareerTrace. You receive the student's message and their current state (role, hours, budget, skills with known and missing elements, roadmap nodes).
Reply with ONLY one JSON object, no prose, no markdown: {"say": string (max 2 short sentences), "actions": [ ... ]}.
Action types:
{"type":"know","skill":string,"element":string}   the student says they know something. Reuse an existing skill and element name from state when one matches.
{"type":"forget","skill":string,"element":string}
{"type":"role","role":string}   one of state.roles when it fits.
{"type":"profile","hours":number,"budget":number,"weeks":number}   include only fields the student changed.
{"type":"addNode","title":string,"skill":string,"elements":[3 to 6 short strings],"after":nodeId or null}   only for a role or topic the roadmap does not cover.
Optionally add "blocks": up to 3 UI blocks that visualise your answer, using only numbers present in state. Block types (all fields short):
{"type":"stat","label","value":number or string,"unit"?,"note"?}
{"type":"bars","title","items":[{"label","value":0-100,"note"?,"skill"?:skill name}]}
{"type":"timeline","title","items":[{"label","weeks":number,"state":"done"|"now"|"next"|"stretch","node"?:nodeId,"note"?}]}
{"type":"cards","title","items":[{"title","body","tag"?,"do"?}]}
{"type":"compare","title","columns":[strings],"rows":[[row label, ...cells]]}
{"type":"callout","tone":"info"|"warn","text"}
{"type":"actions","items":[{"label","do"}]}   "do" is one of: node:<nodeId>, skill:<skill name>, forge, layout, chat:<text>.
Use blocks when the student asks for a status, comparison, plan or next steps. Make the smallest change that fits the message. Never invent market statistics. If unsure, return an empty actions list and ask one short question in "say".`,
  forge: `You design one portfolio project for a student. Reply with ONLY one JSON object: {"title","hook","whyYou","dataSource","week1","benchmark","rubric":[3 to 5 pass/fail checks],"readme":[4 to 6 section titles]}.
Rules: not a to-do app, not Titanic, not a plain RAG chatbot. Build on the student's missing skill elements and existing projects in the state. Give a measurable benchmark. Name a data source and how to get it, but never invent URLs. Keep every field under 220 characters.`,
  roadmap: `Design a learning roadmap for the target role, personalised to the student's state (skills known, hours, deadline). Reply with ONLY one JSON object: {"role": string, "summary": string (max 200 chars), "nodes": [4 to 7 items]}.
Each node: {"id": short slug, "title", "phase": "Prerequisite"|"SteppingStone"|"Specialization"|"TargetRole", "skill": one short skill name, "hours": number, "requires": [earlier node ids], "elements": [3 to 7 concrete things to learn, short], "why": one sentence on why this matters (no statistics), "whyYou": one sentence citing the student's own state, "project": {"title","rubric":[3 to 5 pass/fail checks]}}.
Order nodes so prerequisites come first. Skip elements the student already knows. The last node is a proof project for the target role. Never invent market statistics or URLs.`,
  outreach: `Write a short note from a student to a senior or alumnus asking for advice. Reply with ONLY one JSON object: {"note": string}. The note must be under 300 characters, reference one specific project or repo from the state, ask one concrete question, and avoid flattery and filler.`,
};
// Never trust model output: bound sizes, unique ids, and only allow prerequisites that come earlier (so the graph is acyclic).
function cleanRoadmap(j) {
  if (!j || !Array.isArray(j.nodes)) return null;
  const s = (v, n) => String(v == null ? "" : v).slice(0, n),
    seen = new Set(),
    out = [],
    src = {};
  j.nodes.slice(0, 8).forEach((n, i) => {
    if (!n || !n.title || !n.skill) return;
    let id =
      s(n.id || n.title, 24)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "") || "n" + i;
    if (seen.has(id)) id += "_" + i;
    seen.add(id);
    const el = (Array.isArray(n.elements) ? n.elements : [])
      .map((x) => s(x, 60))
      .filter(Boolean)
      .slice(0, 8);
    if (el.length < 2) return;
    src[String(n.id)] = id;
    out.push({
      id,
      title: s(n.title, 40),
      phase: [
        "Prerequisite",
        "SteppingStone",
        "Specialization",
        "TargetRole",
      ].includes(n.phase)
        ? n.phase
        : "SteppingStone",
      skill: s(n.skill, 30),
      hours: Math.max(6, Math.min(120, +n.hours || 20)),
      _r: Array.isArray(n.requires) ? n.requires.map(String) : [],
      elements: el,
      why: s(n.why, 200),
      whyYou: s(n.whyYou, 200),
      project:
        n.project && n.project.title
          ? {
              title: s(n.project.title, 60),
              rubric: (n.project.rubric || []).slice(0, 5).map((x) => s(x, 80)),
            }
          : null,
    });
  });
  if (out.length < 2) return null;
  out.forEach((o, i) => {
    o.requires = o._r
      .map((r) => src[r])
      .filter((r) => r && out.findIndex((x) => x.id === r) < i);
    delete o._r;
  });
  return { role: s(j.role, 40), summary: s(j.summary, 240), nodes: out };
}
async function llm(system, user, max = 1024) {
  if (!KEY) {
    const e = new Error("NVIDIA_API_KEY is not set");
    e.code = 503;
    throw e;
  }
  const r = await fetch(BASE + "/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(user) },
      ],
      temperature: 0.4,
      top_p: 1,
      max_tokens: max,
      stream: false,
    }),
  });
  const j = await r.json();
  if (!r.ok) {
    const e = new Error("upstream: " + JSON.stringify(j).slice(0, 300));
    e.code = 502;
    throw e;
  }
  const t = (j.choices?.[0]?.message?.content || "").replace(
      /<think>[\s\S]*?<\/think>/g,
      "",
    ),
    a = t.indexOf("{"),
    b = t.lastIndexOf("}");
  if (a < 0) {
    const e = new Error("model returned no JSON");
    e.code = 502;
    throw e;
  }
  return JSON.parse(t.slice(a, b + 1));
}

const server = http
  .createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, "http://localhost");
      const p = parsedUrl.pathname,
        post = req.method === "POST",
        put = req.method === "PUT";
      
      let user = null;
      if (p.startsWith('/api/') && p !== '/api/auth/login' && p !== '/api/auth/register' && p !== '/api/health') {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : parsedUrl.searchParams.get('token');
        if (token) {
          try { user = jwt.verify(token, JWT_SECRET); } catch (e) {}
        }
        if (!user) return send(res, 401, { error: 'Unauthorized' });
      }
      if (p === "/api/health")
        return send(res, 200, { server: true, ok: !!KEY, model: MODEL });
      if (p === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write("retry: 2000\n\n");
        clients.add(res);
        const k = setInterval(() => res.write(": ping\n\n"), 20000);
        req.on("close", () => {
          clearInterval(k);
          clients.delete(res);
        });
        return;
      }
      if (p === "/api/state") {
        if (put) {
          const newState = (await body(req)).state || null;
          await stateCol.updateOne({ userId: user.id }, { $set: { state: newState } }, { upsert: true });
          return send(res, 200, { ok: true });
        }
        const doc = await stateCol.findOne({ userId: user.id });
        return send(res, 200, { state: doc ? doc.state : null });
      }
      if (p === "/api/rv") {
        if (put) {
          const ent = (await body(req)).entries || {};
          const doc = await rvCol.findOne({ userId: user.id }) || { store: {} };
          const rv = doc.store;
          for (const k of Object.keys(ent)) {
            const n = ent[k], o = rv[k];
            if (!o || rank(n) >= rank(o)) rv[k] = n;
          }
          await rvCol.updateOne({ userId: user.id }, { $set: { store: rv } }, { upsert: true });
          emit("rv");
          return send(res, 200, { ok: true });
        }
        const doc = await rvCol.findOne({ userId: user.id });
        return send(res, 200, { store: doc ? doc.store : {} });
      }
      let m = p.match(/^\/api\/chat\/([\w-]+)$/);
      if (m) {
        const g = m[1];
        if (post) {
          const b = await body(req);
          const text = String(b.text || "").trim().slice(0, 500);
          if (!text) return send(res, 400, { error: "empty" });
          await chatCol.updateOne({ groupId: g }, { $push: { messages: { $each: [{ name: String(b.name || "Student").slice(0, 40), text, t: Date.now() }], $slice: -200 } } }, { upsert: true });
          emit("chat", { gid: g });
          return send(res, 200, { ok: true });
        }
        const doc = await chatCol.findOne({ groupId: g });
        return send(res, 200, { messages: doc ? doc.messages : [] });
      }
      if (
        post &&
        (p === "/api/guide" ||
          p === "/api/forge" ||
          p === "/api/outreach" ||
          p === "/api/roadmap")
      ) {
        const b = await body(req),
          kind = p.slice(5);
        try {
          const out = await llm(
            SYS[kind],
            kind === "guide" ? { message: b.message, state: b.state } : b,
            kind === "guide" ? 1200 : kind === "roadmap" ? 2200 : 700,
          );
          if (kind === "guide")
            return send(res, 200, {
              say: String(out.say || ""),
              actions: Array.isArray(out.actions)
                ? out.actions.slice(0, 12)
                : [],
              blocks: Array.isArray(out.blocks) ? out.blocks.slice(0, 3) : [],
            });
          if (kind === "roadmap") {
            const r = cleanRoadmap(out);
            return r
              ? send(res, 200, r)
              : send(res, 502, { error: "model returned an unusable roadmap" });
          }
          if (kind === "outreach")
            return send(res, 200, {
              note: String(out.note || "").slice(0, 299),
            });
          return send(res, 200, out);
        } catch (e) {
          return send(res, e.code || 500, { error: String(e.message || e) });
        }
      }
      if (post && p === "/api/auth/login") {
        if (!usersCol) return send(res, 503, { error: "Database not connected. Check MongoDB Atlas Network Access (IP Whitelist)." });
        const b = await body(req);
        const userDoc = await usersCol.findOne({ username: b.username });
        if (!userDoc) {
          return send(res, 401, { error: "Invalid username or password" });
        }
        if (!bcrypt.compareSync(b.password, userDoc.password)) {
          return send(res, 401, { error: "Invalid username or password" });
        }
        const token = jwt.sign({ id: userDoc._id, username: userDoc.username }, JWT_SECRET, { expiresIn: '7d' });
        return send(res, 200, { ok: true, token, user: { username: userDoc.username, fullname: userDoc.fullname, college: userDoc.college } });
      }
      if (post && p === "/api/auth/register") {
        if (!usersCol) return send(res, 503, { error: "Database not connected. Check MongoDB Atlas Network Access (IP Whitelist)." });
        const b = await body(req);
        const existing = await usersCol.findOne({ username: b.username });
        if (existing) return send(res, 400, { error: 'Username taken' });
        const hashed = bcrypt.hashSync(b.password, 10);
        await usersCol.insertOne({ username: b.username, password: hashed, fullname: b.fullname || b.username, email: b.email, college: b.college || '' });
        return send(res, 200, { ok: true, message: "Registration successful! Please login." });
      }
      // static files; /mentor and /review/* open the app in mentor mode
      let f;
      if (p === "/") f = "/landing.html";
      else if (p === "/login") f = "/login.html";
      else if (p === "/register") f = "/register.html";
      else if (p === "/dashboard" || p === "/mentor" || p.startsWith("/review"))
        f = "/index.html";
      else f = p;
      const file = path.normalize(path.join(__dirname, "public", f));
      if (!file.startsWith(path.join(__dirname, "public"))) {
        res.writeHead(403);
        return res.end();
      }
      fs.readFile(file, (e, d) => {
        if (e) {
          res.writeHead(404);
          return res.end("not found");
        }
        const ext = path.extname(file);
        const headers = {
          "Content-Type": mime[ext] || "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY"
        };
        // Cache static assets for 1 day, no-cache for HTML to ensure latest app loads
        if (['.png', '.ico', '.svg', '.css', '.js'].includes(ext)) {
          headers["Cache-Control"] = "public, max-age=86400";
        } else {
          headers["Cache-Control"] = "no-cache";
        }
        res.writeHead(200, headers);
        res.end(d);
      });
    } catch (e) {
      send(res, 500, { error: String(e.message || e) });
    }
  });

server.listen(PORT, HOST, () =>
  console.log(
    `CareerTrace: http://localhost:${PORT}   mentor link: http://localhost:${PORT}/mentor   live model: ${KEY ? MODEL : "OFF (set NVIDIA_API_KEY in .env)"}`,
  ),
);

// Graceful shutdown for cloud deployments
const shutdown = async () => {
  console.log('\nShutting down gracefully...');
  try {
    if (db && db.client) await db.client.close();
  } catch (e) {}
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
  // Force close after 10s
  setTimeout(() => process.exit(1), 10000);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
