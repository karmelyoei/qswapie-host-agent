// The proactive host agent: Claude with tool use, plus an offline rule-based fallback.
import Anthropic from "@anthropic-ai/sdk";
import { Sim, clock } from "./engine.ts";

const MODEL = "claude-sonnet-5-5";
const MAX_TOKENS = 1200;
const MIN_GAP_MS = 5000; // at most one Claude run per 5 real seconds (offline rules may run every second)
const MAX_CALLS = Number(process.env.AGENT_MAX_CALLS ?? 150); // hard budget per server run

const SYSTEM = `You are the proactive AI host of Kiez Cuts, a walk-in barbershop using the QSwapie digital queue. Guests wait anywhere and get messages from you.
Every few minutes you get the live queue and new signals. Act on your own; nobody will ask you. Use action tools only when they help; doing nothing is fine.
Goals: chairs never sit idle waiting for a guest, guests get honest waits (always give ranges, never promise), hurried guests get a fair swap, the owner hears about problems early.
Rules:
- head_back_now: when a guest is away and their wait range low end is at or below their walk time + 3 min, or when they were called. Send once.
- come_back_later: when an away guest has a long wait (low end over 20 min) and has not been told; give the range.
- mark_no_show: a called guest not arrived after 5+ min. This moves the line up.
- propose_swap: a hurry guest with someone ahead who has swapOk. Pick the swapOk guest closest ahead. Message both is done by the system.
- alert_owner: backlog over 40 min (suggest pause_joins), 2+ no-shows in 30 min (suggest none, just inform), joins paused and backlog under 20 (suggest resume_joins).
Messages: short, warm, plain English, max 25 words, first name, use the wait range. Every tool call needs a one-line reason.`;

const reason = { type: "string", description: "one-line reason shown in the activity feed" };
const TOOLS: Anthropic.Tool[] = [
  { name: "get_queue", description: "Get the current queue state again.", input_schema: { type: "object", properties: {} } },
  { name: "predict_wait", description: "Predict the wait range in minutes for one guest.", input_schema: { type: "object", properties: { guest_id: { type: "string" } }, required: ["guest_id"] } },
  {
    name: "message_guest", description: "Send a message to a guest's phone.",
    input_schema: { type: "object", properties: { guest_id: { type: "string" }, kind: { type: "string", enum: ["head_back_now", "come_back_later", "update"] }, text: { type: "string" }, reason }, required: ["guest_id", "kind", "text", "reason"] },
  },
  {
    name: "propose_swap", description: "Ask the partner guest (ahead in line, swapOk) to swap places with the hurried guest. Both get a message.",
    input_schema: { type: "object", properties: { hurry_guest_id: { type: "string" }, partner_guest_id: { type: "string" }, reason }, required: ["hurry_guest_id", "partner_guest_id", "reason"] },
  },
  { name: "mark_no_show", description: "Release a called guest who did not arrive; the next guest is called.", input_schema: { type: "object", properties: { guest_id: { type: "string" }, reason }, required: ["guest_id", "reason"] } },
  {
    name: "alert_owner", description: "Show an alert on the owner's screen with one suggested action button.",
    input_schema: { type: "object", properties: { text: { type: "string" }, suggested_action: { type: "string", enum: ["pause_joins", "resume_joins", "add_staff", "none"] }, reason }, required: ["text", "suggested_action", "reason"] },
  },
];

const VOICE_SYSTEM = `You are Fade, the AI host of Kiez Cuts, a walk-in barbershop on the QSwapie digital queue. The barber talks to you hands-free while cutting hair, and your answer is spoken out loud.
Style: max 2 short sentences, warm and funny barbershop banter, but always useful. Plain words, no lists, no markdown, no emojis. Say times like 18:40.
Never guess numbers: use day_summary, estimate_finish, capacity_check, recent_events for facts. When the barber asks to open or close the queue, call open_queue or close_queue, then confirm.
For "should we close or take N more": run capacity_check with N and give a clear yes or no with the finish time vs closing time.
For "anything new": run recent_events and mention cancellations, swaps and no-shows, skip routine joins.`;

const VOICE_TOOLS: Anthropic.Tool[] = [
  { name: "day_summary", description: "Today's numbers: clients today, served, waiting, who is in the chair, queue open or closed, closing time, estimated finish.", input_schema: { type: "object", properties: {} } },
  { name: "estimate_finish", description: "When the last client in line will be done at the current pace.", input_schema: { type: "object", properties: {} } },
  { name: "capacity_check", description: "Can the shop take extra clients before closing time? Returns finish time with the extra clients and whether it fits.", input_schema: { type: "object", properties: { extra_clients: { type: "integer" } }, required: ["extra_clients"] } },
  { name: "open_queue", description: "Open the queue so new walk-ins can join.", input_schema: { type: "object", properties: { reason } } },
  { name: "close_queue", description: "Close the queue for new walk-ins. People already in line stay.", input_schema: { type: "object", properties: { reason } } },
  { name: "recent_events", description: "What happened since the barber last asked: cancellations, swaps, no-shows, joins.", input_schema: { type: "object", properties: {} } },
];

// Short, honest label for why a Claude call failed.
function failure(err: unknown) {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (err instanceof Anthropic.APIConnectionError) return "network";
  if (err instanceof Anthropic.APIError) {
    const msg = (err.error as any)?.error?.message ?? "";
    return `API ${err.status ?? "?"}${msg ? `: ${String(msg).slice(0, 80)}` : ""}`;
  }
  return "agent error";
}

export class Agent {
  client: Anthropic | null;
  mode: "AI" | "offline";
  offlineReason = "";
  busy = false;
  lastRun = 0;
  calls = 0;
  inTok = 0;
  outTok = 0;
  private retryAt = 0;
  private busySince = 0;
  private lastSafetyNet = 0;

  private sim: Sim;

  constructor(sim: Sim) {
    this.sim = sim;
    this.client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ maxRetries: 1, timeout: 30000 }) : null;
    this.mode = this.client ? "AI" : "offline";
    if (!this.client) this.offlineReason = "no API key set";
  }

  status() {
    return { mode: this.mode, offlineReason: this.offlineReason, busy: this.busy, calls: this.calls, maxCalls: MAX_CALLS, inTok: this.inTok, outTok: this.outTok, model: MODEL };
  }

  // Called every real second. Proactive: runs when the sim produced new signals or on a quiet heartbeat.
  async tick() {
    const sim = this.sim;
    if (sim.dayClosed || !sim.running) return;
    const now = Date.now();
    if (this.busy) {
      // A slow Claude call never freezes the venue: after 10 s the offline rules act as a safety net.
      if (now - this.busySince > 10000 && now - this.lastSafetyNet > 3000) { this.lastSafetyNet = now; this.rules([]); }
      return;
    }
    if (now - this.lastRun < (this.mode === "AI" ? MIN_GAP_MS : 1000)) return;
    this.watchdog();
    if (!sim.signals.length) return;
    this.lastRun = now;
    const signals = sim.signals.splice(0);

    if (this.client && this.mode === "offline" && now >= this.retryAt && this.calls < MAX_CALLS && this.offlineReason !== "no API key set") {
      this.mode = "AI"; this.offlineReason = "";
    }
    if (this.client && this.mode === "AI" && this.calls >= MAX_CALLS) { this.mode = "offline"; this.offlineReason = "token budget reached"; }

    if (this.mode === "AI") {
      this.busy = true; this.busySince = now;
      try { await this.runClaude(signals); }
      catch (err) {
        this.goOffline(failure(err));
        this.rules(signals);
      } finally { this.busy = false; }
    } else {
      this.rules(signals);
    }
  }

  private goOffline(why: string) {
    this.mode = "offline"; this.offlineReason = why; this.retryAt = Date.now() + 15000;
    this.sim.log("offline", "fallback", `Claude unavailable (${why}); offline rules took over`, "keep the venue running");
  }

  // Situations that need attention even when nothing new happened.
  private watchdog() {
    const sim = this.sim;
    for (const id of sim.line) {
      const g = sim.get(id)!;
      if (g.away && g.headedBackAt === undefined && !g.notified.includes("_near") && (g.wait?.[0] ?? 99) <= g.walk + 3) {
        g.notified.push("_near"); sim.signal(`${g.name} is getting close to the front (wait ${g.wait?.join("-")} min, ${g.walk} min walk)`);
      }
    }
    const open = (action: string) => sim.alerts.some((a) => a.action === action && (a.status === "open" || sim.t - a.t < 15));
    if (sim.scenario !== "barber" && sim.backlog() >= 40 && !sim.joinsPaused && !open("pause_joins")) this.once("backlog", `backlog is ${sim.backlog()} min`);
    if (sim.scenario !== "barber" && sim.joinsPaused && sim.backlog() < 20 && !open("resume_joins")) this.once("resume", `joins are paused and backlog is down to ${sim.backlog()} min`);
  }

  // Raise a watchdog signal at most once per 10 sim minutes, so a "no action" answer does not trigger a new call every tick.
  private cooldown = new Map<string, number>();
  private once(key: string, text: string) {
    const last = this.cooldown.get(key);
    if (last !== undefined && this.sim.t - last < 10) return;
    this.cooldown.set(key, this.sim.t);
    this.sim.signal(text);
  }

  private exec(name: string, input: any, mode: "AI" | "offline"): string {
    const sim = this.sim;
    const who = (id: string) => sim.get(id)?.name ?? id;
    let out = "";
    switch (name) {
      case "get_queue": return JSON.stringify(sim.agentView());
      case "predict_wait": { const g = sim.get(input.guest_id); return g?.wait ? `${g.wait[0]}-${g.wait[1]} min` : "not waiting"; }
      case "message_guest": out = sim.messageGuest(input.guest_id, input.kind, input.text); if (!out.startsWith("error")) sim.log(mode, "message_guest", `To ${who(input.guest_id)}: "${input.text}"`, input.reason); break;
      case "propose_swap": {
        out = sim.proposeSwap(input.hurry_guest_id, input.partner_guest_id);
        if (!out.startsWith("error")) {
          const a = sim.get(input.hurry_guest_id)!, b = sim.get(input.partner_guest_id)!;
          b.messages.push({ t: sim.t, from: "agent", kind: "swap", text: `Hi ${b.name}, ${a.name} is in a hurry. Would you swap to place ${sim.line.indexOf(a.id) + 1}? You'd still get a heads-up before your turn.` });
          a.messages.push({ t: sim.t, from: "agent", kind: "swap", text: `Hi ${a.name}, I asked ${b.name} (place ${sim.line.indexOf(b.id) + 1}) to swap with you. I'll tell you in a minute.` });
          sim.log(mode, "propose_swap", `Asked ${b.name} to swap with ${a.name}`, input.reason);
        }
        break;
      }
      case "mark_no_show": out = sim.markNoShow(input.guest_id); if (!out.startsWith("error")) sim.log(mode, "mark_no_show", `${who(input.guest_id)} marked no-show, line moved up`, input.reason); break;
      case "alert_owner": out = sim.scenario === "barber" && /joins/.test(input.suggested_action) ? "error: in barber voice mode the barber opens and closes the queue by voice" : sim.alertOwner(input.text, input.reason, input.suggested_action); if (!out.startsWith("error")) sim.log(mode, "alert_owner", input.text, input.reason); break;
      default: out = "error: unknown tool";
    }
    return out;
  }

  private async runClaude(signals: string[]) {
    const sim = this.sim;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: `New signals:\n${signals.join("\n")}\nQueue:${JSON.stringify(sim.agentView())}` }];
    // At most 2 requests per run: one to act, one more only if it asked to read state.
    for (let i = 0; i < 2; i++) {
      this.calls++;
      const res = await this.create("tick", {
        model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, tools: TOOLS, messages,
        output_config: { effort: "low" },
      });
      
      if (res.stop_reason === "refusal") { this.rules(signals); return; }
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!uses.length) {
        sim.log("AI", "watch", `Checked the queue at ${clock(sim.t)}: no action needed`, signals[signals.length - 1]?.slice(6) ?? "");
        return;
      }
      const results: Anthropic.ToolResultBlockParam[] = uses.map((u) => {
        const out = this.exec(u.name, u.input, "AI");
        return { type: "tool_result", tool_use_id: u.id, content: out, is_error: out.startsWith("error") };
      });
      const onlyReads = uses.every((u) => u.name === "get_queue" || u.name === "predict_wait");
      if (!onlyReads || res.stop_reason !== "tool_use") return;
      messages.push({ role: "assistant", content: res.content }, { role: "user", content: results });
    }
  }

  // Every Claude request goes through here: token counter + duration log (never the key).
  private async create(kind: string, params: Anthropic.MessageCreateParamsNonStreaming) {
    const t0 = Date.now();
    try {
      const res = await this.client!.messages.create(params);
      this.inTok += res.usage.input_tokens; this.outTok += res.usage.output_tokens;
      console.log(`[claude] ${kind} ${Date.now() - t0} ms, ${res.usage.input_tokens} in / ${res.usage.output_tokens} out, stop=${res.stop_reason}`);
      return res;
    } catch (err) {
      console.log(`[claude] ${kind} FAILED after ${Date.now() - t0} ms: ${failure(err)}: ${(err as Error).message}`);
      throw err;
    }
  }

  // Offline fallback: same goals, fixed rules, template messages.
  rules(_signals: string[]) {
    const sim = this.sim;
    for (const g of sim.guests.filter((x) => x.status === "called")) {
      const late = sim.t - (g.calledAt ?? sim.t);
      if (late >= 5) this.exec("mark_no_show", { guest_id: g.id, reason: `called ${Math.round(late)} min ago, not here` }, "offline");
      else if (g.away && g.headedBackAt === undefined && !g.notified.includes("head_back_now"))
        this.exec("message_guest", { guest_id: g.id, kind: "head_back_now", text: `${g.name}, it's your turn now. Please head back.`, reason: "guest was called while away" }, "offline");
    }
    for (const id of [...sim.line]) {
      const g = sim.get(id)!;
      if (!g.away || g.headedBackAt !== undefined || !g.wait) continue;
      if (g.wait[0] <= g.walk + 3 && !g.notified.includes("head_back_now"))
        this.exec("message_guest", { guest_id: g.id, kind: "head_back_now", text: `${g.name}, you're up in about ${g.wait[0]} to ${g.wait[1]} min. Please head back now.`, reason: `wait ${g.wait[0]} min vs ${g.walk} min walk` }, "offline");
      else if (g.wait[0] > 20 && !g.notified.includes("come_back_later"))
        this.exec("message_guest", { guest_id: g.id, kind: "come_back_later", text: `${g.name}, no rush. Your wait is about ${g.wait[0]} to ${g.wait[1]} min. We'll ping you.`, reason: "long wait, guest is away" }, "offline");
    }
    for (const id of sim.line) {
      const g = sim.get(id)!;
      if (!g.hurry || sim.swaps.some((s) => s.a === g.id)) continue;
      const pos = sim.line.indexOf(g.id);
      const partner = sim.line.slice(0, pos).reverse().map((x) => sim.get(x)!).find((p) => p.swapOk);
      if (partner) this.exec("propose_swap", { hurry_guest_id: g.id, partner_guest_id: partner.id, reason: `${g.name} is in a hurry; ${partner.name} said swapping is fine` }, "offline");
    }
    const st = sim.stats();
    if (st.backlog >= 40 && !sim.joinsPaused) this.exec("alert_owner", { text: `Queue is ${st.backlog} min deep. Pause new joins?`, suggested_action: "pause_joins", reason: "backlog over 40 min" }, "offline");
    const ns = sim.agentView().noShowsLast30;
    if (ns >= 2) this.exec("alert_owner", { text: `${ns} no-shows in 30 min. Line moved up, next guests called.`, suggested_action: "none", reason: "no-show spike" }, "offline");
    if (sim.joinsPaused && st.backlog < 20) this.exec("alert_owner", { text: `Queue is down to ${st.backlog} min. Open joins again?`, suggested_action: "resume_joins", reason: "backlog back under 20 min" }, "offline");
  }

  // ---- Barber voice mode: the barber talks, the agent answers out loud ----

  private execVoice(name: string, input: any): string {
    const sim = this.sim;
    switch (name) {
      case "day_summary": return JSON.stringify(sim.daySummary());
      case "estimate_finish": return JSON.stringify({ finishAround: clock(sim.finishAt()), closingTime: clock(sim.closeAt), waiting: sim.line.length });
      case "capacity_check": return JSON.stringify(sim.capacity(Math.max(0, Math.round(Number(input.extra_clients) || 0))));
      case "open_queue": sim.setJoins(true, "Barber"); sim.log(this.mode, "open_queue", "Queue opened for new walk-ins", input.reason ?? "barber asked"); return "queue is open";
      case "close_queue": sim.setJoins(false, "Barber"); sim.log(this.mode, "close_queue", "Queue closed for new walk-ins", input.reason ?? "barber asked"); return "queue is closed for new joins; people already in line stay";
      case "recent_events": return JSON.stringify(sim.recentEvents());
      default: return "error: unknown tool";
    }
  }

  async voice(text: string) {
    const sim = this.sim;
    sim.say("barber", text);
    let reply = "";
    if (this.client && this.mode === "AI" && this.calls < MAX_CALLS) {
      try { reply = await this.voiceClaude(); }
      catch (err) { this.goOffline(failure(err)); }
    }
    if (!reply) reply = this.voiceRules(text);
    sim.say("agent", reply);
    return reply;
  }

  private async voiceClaude() {
    const sim = this.sim;
    // Rebuild a short alternating history from the voice transcript.
    const messages: Anthropic.MessageParam[] = [];
    for (const v of sim.voice.slice(-8)) {
      const role = v.who === "barber" ? "user" : "assistant";
      const last = messages[messages.length - 1];
      if (last && last.role === role) last.content += "\n" + v.text;
      else messages.push({ role, content: v.text });
    }
    while (messages.length && messages[0].role !== "user") messages.shift();
    const lastUser = messages[messages.length - 1];
    lastUser.content = `[now ${clock(sim.t)}, queue ${sim.joinsPaused ? "closed" : "open"}, closing ${clock(sim.closeAt)}]\n${lastUser.content}`;
    for (let i = 0; i < 4; i++) {
      this.calls++;
      const res = await this.create("voice", {
        model: MODEL, max_tokens: 600, system: VOICE_SYSTEM, tools: VOICE_TOOLS, messages,
        output_config: { effort: "low" },
      });
      
      if (res.stop_reason === "refusal") return "";
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const said = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(" ").trim();
      if (!uses.length || res.stop_reason !== "tool_use") return said;
      messages.push({ role: "assistant", content: res.content }, {
        role: "user",
        content: uses.map((u) => ({ type: "tool_result" as const, tool_use_id: u.id, content: this.execVoice(u.name, u.input) })),
      });
    }
    return "";
  }

  // Offline voice: keyword intents with the same tools and canned banter.
  private voiceRules(text: string) {
    const sim = this.sim;
    const t = text.toLowerCase();
    const num = Number((/(\d+)\s*more/.exec(t) ?? /\b(one|two|three|four|five)\s+more/.exec(t))?.[1]
      ?.replace("one", "1").replace("two", "2").replace("three", "3").replace("four", "4").replace("five", "5"));
    if (/\b(close|stop|shut)\b/.test(t) && !/should we|or do we/.test(t)) { this.execVoice("close_queue", { reason: "barber said close" }); return `Done, the queue is closed. Everyone already in line still gets their cut.`; }
    if (/\bopen\b/.test(t)) { this.execVoice("open_queue", { reason: "barber said open" }); return `Queue is open, boss. Let's make some heads look expensive.`; }
    if (/power|capacity|more|should we close/.test(t)) {
      const c = sim.capacity(num || 2);
      return c.fits
        ? `Yes: with ${c.extraClients} more you're done around ${c.finishWithExtra}, closing is ${c.closingTime}. Tight but doable, hydrate those clippers.`
        : `Honestly no: ${c.extraClients} more would run to ${c.finishWithExtra}, ${c.minutesOverOrUnder} minutes past closing. I'd close the queue, your back will thank me.`;
    }
    if (/new|happen|update|news/.test(t)) {
      const ev = sim.recentEvents().filter((e) => !/walk-ins joined/.test(e)).slice(-3).map((e) => e.slice(6));
      return ev.length && ev[0] !== "nothing new" ? `${ev.join(". ")}. Drama, but under control.` : `All quiet. Just you, the clippers and good vibes.`;
    }
    if (/today|looking|how/.test(t)) {
      const d = sim.daySummary();
      return `You have ${d.clientsToday} clients today, ${d.waiting} waiting. At this pace you're done around ${d.finishAround}.`;
    }
    return `Didn't catch that over the clippers. Ask me how today looks, what's new, or open or close the queue.`;
  }

  async summary() {
    const st = this.sim.stats();
    const base = `Served ${st.served}, no-shows ${st.noShows}, swaps ${st.swaps}, average wait ${st.avgWait} min, ${st.messages} guest messages, ${st.idleChairMin} idle chair min.`;
    if (this.mode !== "AI" || !this.client) return `End of day: ${base}`;
    try {
      this.calls++;
      const res = await this.create("summary", {
        model: MODEL, max_tokens: 400, output_config: { effort: "low" },
        system: "You are the AI host of a walk-in barbershop. Write the owner a 4-line end-of-day summary: what went well, what went wrong, one concrete tip for tomorrow. Plain text, no markdown.",
        messages: [{ role: "user", content: `Stats: ${JSON.stringify(st)}\nRecent agent actions:\n${this.sim.activity.slice(0, 25).map((a) => `${clock(a.t)} ${a.tool}: ${a.text}`).join("\n")}` }],
      });
      
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
      return text || `End of day: ${base}`;
    } catch {
      return `End of day: ${base}`;
    }
  }
}
