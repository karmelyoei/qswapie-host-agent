// Local demo server: runs the simulation + agent and serves the UI. No external calls except the Anthropic API.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Sim, clock } from "./engine.ts";
import { Agent } from "./agent.ts";

try { process.loadEnvFile(".env"); } catch { /* no .env: fine */ }

const PORT = Number(process.env.PORT ?? 5173);
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
    case "reset": sim = new Sim(); agent = new Agent(sim); break;
  }
}

http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/state") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(state()));
    }
    if (req.url === "/api/action" && req.method === "POST") {
      let raw = "";
      for await (const c of req) raw += c;
      await action(JSON.parse(raw || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("{}");
    }
    const file = req.url === "/" ? "index.html" : (req.url ?? "").replace(/^\/+/, "");
    const full = path.join(PUBLIC, path.normalize(file));
    if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": full.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain" });
    res.end(fs.readFileSync(full));
  } catch {
    res.writeHead(500); res.end("error");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`QSwapie Host Agent running at http://localhost:${PORT}`);
  console.log(`Agent mode: ${agent.mode}${agent.offlineReason ? ` (${agent.offlineReason})` : ""}`);
});

// When the guest entered their current state; messages from before it are shown greyed out.
function stateAt(g: { status: string; calledAt?: number; startAt?: number; endAt?: number }) {
  if (g.status === "called") return g.calledAt ?? 0;
  if (g.status === "serving") return g.startAt ?? 0;
  if (g.status === "done" || g.status === "noshow") return g.endAt ?? 0;
  return -1;
}
