// Smoke test: runs the server against a mock NVIDIA endpoint, so no real key or internet is needed.
const http = require("http"),
  { spawn } = require("child_process"),
  fs = require("fs"),
  os = require("os"),
  path = require("path");
const MOCK = 4991,
  PORT = 4992,
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ct-"));
let fails = 0;
const ok = (c, m) => {
  console.log((c ? "PASS " : "FAIL ") + m);
  if (!c) fails++;
};
const mock = http
  .createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    const j = JSON.parse(b),
      sys = j.messages[0].content;
    const out = sys.includes("You are Guide")
      ? {
          say: "Noted.",
          actions: [
            { type: "know", skill: "SQL", element: "window functions" },
          ],
        }
      : sys.includes("portfolio project")
        ? {
            title: "Mock project",
            hook: "h",
            whyYou: "w",
            dataSource: "d",
            week1: "w1",
            benchmark: "b",
            rubric: ["a", "b", "c"],
            readme: ["x", "y", "z", "q"],
          }
        : { note: "Hi Ria, I built a price tracker. One question about SQL?" };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                "<think>x</think>```json\n" + JSON.stringify(out) + "\n```",
            },
          },
        ],
      }),
    );
  })
  .listen(MOCK);
const srv = spawn("node", ["server.js"], {
  cwd: __dirname,
  env: {
    ...process.env,
    PORT,
    HOST: "127.0.0.1",
    DATA_DIR: DATA,
    NVIDIA_API_KEY: "test",
    NVIDIA_BASE_URL: `http://127.0.0.1:${MOCK}/v1`,
  },
});
const U = (p) => `http://127.0.0.1:${PORT}${p}`,
  J = (p, m, b) =>
    fetch(U(p), {
      method: m || "GET",
      headers: { "Content-Type": "application/json" },
      body: b ? JSON.stringify(b) : undefined,
    }).then((r) => r.json());
(async () => {
  await new Promise((r) => setTimeout(r, 700));
  const h = await J("/api/health");
  ok(h.server && h.ok, "health reports key set");
  const g = await J("/api/guide", "POST", {
    message: "i know window functions",
    state: {},
  });
  ok(
    g.actions && g.actions[0].type === "know",
    "guide parses model JSON (fences and think blocks stripped)",
  );
  const f = await J("/api/forge", "POST", { state: {} });
  ok(
    f.title === "Mock project" && f.rubric.length === 3,
    "forge returns a project",
  );
  const o = await J("/api/outreach", "POST", { state: {} });
  ok(o.note && o.note.length < 300, "outreach note is under 300 characters");
  await J("/api/state", "PUT", { state: { a: 1 } });
  ok((await J("/api/state")).state.a === 1, "state persists");
  await J("/api/rv", "PUT", {
    entries: { r1: { id: "r1", status: "answered", v: "mentor" } },
  });
  await J("/api/rv", "PUT", { entries: { r1: { id: "r1", status: "open" } } });
  ok(
    (await J("/api/rv")).store.r1.status === "answered",
    "stale open review cannot overwrite an answered one",
  );
  const got = new Promise((r) => {
    http.get(U("/api/events"), (res) => {
      res.on("data", (d) => {
        if (String(d).includes("event: chat")) r(true);
      });
    });
    setTimeout(() => r(false), 3000);
  });
  await new Promise((r) => setTimeout(r, 200));
  await J("/api/chat/g1", "POST", { name: "A", text: "hello" });
  ok(await got, "chat message pushed over SSE");
  ok(
    (await J("/api/chat/g1")).messages[0].text === "hello",
    "chat history stored",
  );
  const idx = await fetch(U("/mentor"));
  ok(
    idx.status === 200 && (await idx.text()).includes("CareerTrace"),
    "/mentor serves the app",
  );
  const tr = await fetch(U("/../server.js"));
  ok(
    tr.status !== 200 || !(await tr.text()).includes("NVIDIA_API_KEY"),
    "path traversal blocked",
  );
  srv.kill();
  mock.close();
  console.log(fails ? fails + " FAILED" : "ALL PASSED");
  process.exit(fails ? 1 : 0);
})();
