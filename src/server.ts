// Local demo server: runs the simulation + agent and serves the UI.
// External calls: the Anthropic API, and Reson8 speech-to-text (proxied here so its key never reaches the browser).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Sim, clock } from "./engine.ts";
import { Agent } from "./agent.ts";
import { WebSocketServer, WebSocket } from "ws";

try { process.loadEnvFile(".env"); } catch { /* no .env: fine */ }

const PORT = Number(process.env.PORT ?? 5173);
const WAKE_WORDS = (process.env.WAKE_WORDS || "hey hazel,hazel,hey hasel,hey hazle,hey q,hey queue,hey cue,hey kyu").split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
const PUBLIC = path.join(import.meta.dirname, "..", "public");

let sim = new Sim();
let agent = new Agent(sim);

const TICK_MS = 250;
setInterval(() => sim.step((sim.speed * TICK_MS) / 1000), TICK_MS);
setInterval(() => { void agent.tick(); }, 1000);

function state() {
  return {
    now: clock(sim.t),
    speed: sim.speed,
    running: sim.running,
    staff: sim.staff,
    joinsPaused: sim.joinsPaused,
    dayClosed: sim.dayClosed,
    summary: sim.summary,
    scenario: sim.scenario,
    voiceMode: sim.voiceMode,
    dayStarted: sim.dayStarted,
    barberName: sim.barberName,
    closeAt: clock(sim.closeAt),
    voice: sim.voice.map((v) => ({ ...v, t: clock(v.t) })),
    reson8: Boolean(process.env.RESON8_API_KEY),
    wakeWords: WAKE_WORDS,
    stats: sim.stats(),
    agent: agent.status(),
    line: sim.line,
    guests: sim.guests.filter((g) => g.status !== "done" || sim.t - (g.endAt ?? 0) < 5).map((g) => ({
      id: g.id, name: g.name, status: g.status, hurry: g.hurry, swapOk: g.swapOk, away: g.away, walk: g.walk,
      headedBack: g.headedBackAt !== undefined, wait: g.wait, quoted: g.quoted, place: sim.line.indexOf(g.id) + 1,
      calledMinAgo: g.calledAt !== undefined ? Math.round(sim.t - g.calledAt) : null,
      messages: g.messages.map((m) => ({ ...m, t: clock(m.t), old: m.t < stateAt(g) })),
    })),
    activity: sim.activity.slice(0, 60).map((a) => ({ ...a, t: clock(a.t) })),
    alerts: sim.alerts.slice(0, 8).map((a) => ({ ...a, t: clock(a.t) })),
  };
}

async function action(body: any) {
  switch (body.type) {
    case "rush": sim.rush(); break;
    case "speed": sim.speed = Math.max(0.25, Math.min(8, Number(body.value) || 1)); break;
    case "pause": sim.running = !sim.running; break;
    case "staff": sim.staff = Math.max(1, Math.min(4, sim.staff + (body.delta > 0 ? 1 : -1))); sim.signal(`Staff now ${sim.staff}`); sim.recompute(); break;
    case "joins": sim.joinsPaused = !sim.joinsPaused; sim.signal(`Owner ${sim.joinsPaused ? "paused" : "opened"} new joins`); break;
    case "join": sim.join({}); break;
    case "hurry": sim.setHurry(String(body.id)); break;
    case "swapok": sim.setSwapOk(String(body.id)); break;
    case "alert": sim.ownerRespond(Number(body.id), Boolean(body.apply)); break;
    case "close": {
      sim.dayClosed = true;
      sim.summary = "Writing summary...";
      sim.summary = await agent.summary();
      sim.log(agent.mode === "AI" ? "AI" : "offline", "summary", "End-of-day summary sent to owner", "day closed");
      break;
    }
    case "reset": sim = new Sim(body.scenario === "barber" ? "barber" : "demo"); agent = new Agent(sim); break;
    case "startday": await agent.greet(); break;
    case "hold": sim.voiceHoldUntil = body.on ? Date.now() + Math.min(30000, Number(body.ms) || 15000) : 0; break; // clock pauses while the barber talks to Hazel
    case "closetime": { const m = /^(\d{1,2}):(\d{2})$/.exec(String(body.value)); if (m) sim.closeAt = Number(m[1]) * 60 + Number(m[2]); break; }
    case "voice": { const text = String(body.text ?? "").trim().slice(0, 500); if (text) await agent.voice(text); break; }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/state") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(state()));
    }
    if (req.url === "/api/voice-stream" && req.method === "POST") {
      // Streams Hazel's reply as plain text so the browser can speak the first sentence early.
      let raw = "";
      for await (const c of req) raw += c;
      const text = String(JSON.parse(raw || "{}").text ?? "").trim().slice(0, 500);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" });
      if (text) await agent.voiceTurn(text, (d) => res.write(d));
      return res.end();
    }
    if (req.url === "/api/action" && req.method === "POST") {
      let raw = "";
      for await (const c of req) raw += c;
      await action(JSON.parse(raw || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("{}");
    }
    const urlPath = (req.url ?? "/").split("?")[0]; // allow ?voice=off, ?skin=new
    // The Codex stage skin is the default; ?skin=old serves the classic barber page.
    const oldSkin = /[?&]skin=old\b/.test(req.url ?? "");
    const PAGES: Record<string, string> = { "/": "index.html", "/guests": "index.html", "/barber": oldSkin ? "barber.html" : "skin/barber.html" };
    const file = PAGES[urlPath.replace(/\/+$/, "") || "/"] ?? urlPath.replace(/^\/+/, "");
    const full = path.join(PUBLIC, path.normalize(file));
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": full.endsWith(".html") ? "text/html; charset=utf-8" : full.endsWith(".js") ? "text/javascript; charset=utf-8" : full.endsWith(".css") ? "text/css; charset=utf-8" : full.endsWith(".svg") ? "image/svg+xml" : full.endsWith(".webp") ? "image/webp" : full.endsWith(".png") ? "image/png" : "text/plain" });
    res.end(fs.readFileSync(full));
  } catch {
    res.writeHead(500); res.end("error");
  }
});

// Browser mic audio (16 kHz mono PCM s16le) -> Reson8 Turns -> transcripts back to the browser.
const wss = new WebSocketServer({ server, path: "/stt" });
wss.on("connection", (browser) => {
  const key = process.env.RESON8_API_KEY;
  if (!key) return browser.close(4001, "no Reson8 key");
  const url = "wss://api.reson8.dev/v1/speech-to-text/turns?encoding=pcm_s16le&sample_rate=16000&channels=1&language=en";
  const upstream = new WebSocket(url, { headers: { Authorization: `ApiKey ${key}` } });
  const queued: Buffer[] = [];
  upstream.on("open", () => { for (const b of queued.splice(0)) upstream.send(b); });
  upstream.on("message", (data, isBinary) => { if (!isBinary && browser.readyState === WebSocket.OPEN) browser.send(data.toString()); });
  upstream.on("unexpected-response", (_req, r) => { browser.close(4002, `Reson8 HTTP ${r.statusCode}`); upstream.terminate(); });
  upstream.on("error", () => { if (browser.readyState === WebSocket.OPEN) browser.close(4002, "Reson8 error"); });
  upstream.on("close", (code) => { if (browser.readyState === WebSocket.OPEN) browser.close(4002, `Reson8 closed ${code}`); });
  browser.on("message", (data, isBinary) => {
    if (isBinary) { if (upstream.readyState === WebSocket.OPEN) upstream.send(data as Buffer); else if (upstream.readyState === WebSocket.CONNECTING) queued.push(data as Buffer); }
    else if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString()); // e.g. flush_request
  });
  browser.on("close", () => upstream.close());
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`QSwapie Host Agent running at http://localhost:${PORT}`);
  console.log(`Agent mode: ${agent.mode}${agent.offlineReason ? ` (${agent.offlineReason})` : ""}`);
  console.log(`Speech-to-text: ${process.env.RESON8_API_KEY ? "Reson8" : "browser fallback (no RESON8_API_KEY)"}`);
});

// When the guest entered their current state; messages from before it are shown greyed out.
function stateAt(g: { status: string; calledAt?: number; startAt?: number; endAt?: number }) {
  if (g.status === "called") return g.calledAt ?? 0;
  if (g.status === "serving") return g.startAt ?? 0;
  if (g.status === "done" || g.status === "noshow") return g.endAt ?? 0;
  return -1;
}
