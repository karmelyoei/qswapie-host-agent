// Simulated walk-in queue. All guests are fake; nothing talks to QSwapie.

export type Status = "waiting" | "called" | "serving" | "done" | "noshow" | "left";

export interface Msg { t: number; text: string; kind: string; from: "agent" | "system" | "guest" }

export interface Guest {
  id: string;
  name: string;
  joinedAt: number;
  status: Status;
  hurry: boolean;
  swapOk: boolean;
  away: boolean; // waiting somewhere else (QSwapie "wait anywhere")
  walk: number; // minutes to walk back
  willNoShow: boolean; // hidden from the agent
  service: number; // hidden from the agent
  expected?: number; // booked cut length, known to everyone (morning scenario)
  headedBackAt?: number;
  calledAt?: number;
  arriveAt?: number;
  startAt?: number;
  endAt?: number;
  notified: string[];
  quoted?: [number, number];
  wait?: [number, number];
  messages: Msg[];
}

export interface Activity { t: number; mode: "AI" | "offline" | "sim"; tool: string; text: string; reason: string }

export interface OwnerAlert { id: number; t: number; text: string; reason: string; action: string; status: "open" | "applied" | "dismissed" }

export interface Swap { id: number; a: string; b: string; t: number; status: "proposed" | "accepted" | "declined" }

// Morning shift: 15 booked clients in this order, then the waitlist (Max, Zoe).
const MORNING_NAMES = ["Paul", "Mo", "Sara", "Jonas", "Emma", "Lina", "Theo", "Nora", "Ben", "Ada", "Omar", "Ida", "Karl", "Rosa", "Finn", "Max", "Zoe"];
const MORNING_CUTS = [30, 35, 30, 30, 45, 30, 30, 30, 35, 30, 30, 30, 30, 35, 30]; // 480 min: done about 17:00
const BARBER_NAMES = ["Paul", "Mo", "Ben", "Lina", "Ada", "Sara", "Jonas", "Emma", "Theo", "Nora", "Max", "Ida", "Karl", "Rosa", "Finn", "Lea", "Oskar", "Hanna", "Emil", "Zoe"];
const NAMES = ["Mia", "Leo", "Noah", "Emma", "Ben", "Lina", "Paul", "Ella", "Finn", "Lea", "Jonas", "Mila", "Elias", "Clara", "Anton", "Ida", "Theo", "Nora", "Max", "Ava", "Luca", "Zoe", "Emil", "Lotta", "Karl", "Rosa", "Milan", "Frida", "Oskar", "Hanna"];
export const MEAN_SERVICE = 12;
const NO_SHOW_FAILSAFE = 12; // engine gives up on a called guest after this many minutes if nobody acts

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clock = (t: number) => `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

export class Sim {
  t = 14 * 60;
  speed = 1; // sim minutes per real second
  running = true;
  staff = 2;
  joinsPaused = false;
  guests: Guest[] = [];
  line: string[] = []; // waiting guest ids in order
  activity: Activity[] = [];
  alerts: OwnerAlert[] = [];
  swaps: Swap[] = [];
  signals: string[] = []; // new things for the agent since its last run
  idleChairMin = 0;
  dayClosed = false;
  summary = "";
  private rand = rng(42);
  private nameIdx = 0;
  private nextId = 1;
  private pendingJoins: { at: number; opts: Partial<Guest> }[] = [];
  private nextAlertId = 1;
  private nextSwapId = 1;

  // Barber voice mode
  scenario: "demo" | "barber";
  closeAt = 19 * 60;
  voiceMode = false;
  events: { t: number; text: string; notable: boolean }[] = [];
  eventsCursor = 0; // recent_events reports from here
  spokenCursor = 0; // proactive voice reports from here
  voice: { id: number; t: number; who: "barber" | "agent"; text: string; proactive?: boolean }[] = [];
  private nextVoiceId = 1;
  private names = NAMES;
  private scheduled: { at: number; run: () => void }[] = [];
  private scriptStarted = false;
  dayStarted = false;
  barberName = process.env.BARBER_NAME || "Nico";

  constructor(scenario: "demo" | "barber" = "demo") {
    this.scenario = scenario;
    const close = /^(\d{1,2}):(\d{2})$/.exec(process.env.CLOSE_TIME ?? "");
    if (close) this.closeAt = Number(close[1]) * 60 + Number(close[2]);
    if (scenario === "barber") {
      // Morning shift: 09:00, one barber, 15 booked clients, closed to walk-ins.
      // The clock waits for the barber's go-ahead by voice; the day's events are scripted so every run is the same.
      this.names = MORNING_NAMES;
      this.t = 9 * 60; this.staff = 1; this.joinsPaused = true; this.voiceMode = true; this.running = false;
      if (!close) this.closeAt = 17 * 60 + 30;
      MORNING_CUTS.forEach((cut, i) => this.join({ away: false, swapOk: i === 8, willNoShow: false, service: cut, expected: cut }, this.t - 30, true));
      this.signals = [];
      this.recompute();
      return;
    }
    for (let i = 0; i < 2; i++) {
      const g = this.makeGuest({ away: false });
      g.joinedAt = this.t - 20;
      g.status = "serving"; g.startAt = this.t - 4 - i * 5; g.endAt = g.startAt + g.service;
      this.guests.push(g);
    }
    for (let i = 0; i < 5; i++) this.join({}, this.t - 15 + i * 3, true);
    this.signals = [];
    this.recompute();
  }

  private makeGuest(opts: Partial<Guest>): Guest {
    const r = this.rand;
    return {
      id: "g" + this.nextId++,
      name: this.names[this.nameIdx++ % this.names.length],
      joinedAt: this.t,
      status: "waiting",
      hurry: false,
      swapOk: r() < 0.35,
      away: r() < 0.8,
      walk: 2 + Math.floor(r() * 7),
      willNoShow: false,
      service: Math.round(MEAN_SERVICE - 4 + r() * 8),
      notified: [],
      messages: [],
      ...opts,
    };
  }

  join(opts: Partial<Guest> = {}, at = this.t, quiet = false) {
    const g = this.makeGuest(opts);
    g.joinedAt = at;
    this.guests.push(g);
    this.line.push(g.id);
    this.recompute();
    g.quoted = g.wait;
    this.sys(g, `You're in line at Kiez Cuts. Place ${this.line.length}. We'll tell you when to come back.`);
    if (!quiet) this.signal(`${g.name} joined (place ${this.line.length}${g.away ? ", waiting away" : ", in the shop"})`);
    if (!quiet) this.event(`${g.name} joined the queue`, false);
    return g;
  }

  event(text: string, notable = true, spoken?: string) {
    this.events.push({ t: this.t, text, notable });
    // Morning shift: Hazel tells the barber right away, in one short line.
    if (spoken && this.voiceMode) { this.say("agent", spoken, true); this.spokenCursor = this.events.length; }
  }

  say(who: "barber" | "agent", text: string, proactive = false) {
    this.voice.push({ id: this.nextVoiceId++, t: this.t, who, text, proactive });
    if (this.voice.length > 40) this.voice.shift();
  }

  cancel(id: string) {
    const g = this.get(id);
    if (!g || g.status !== "waiting") return;
    g.status = "left"; g.endAt = this.t;
    this.sys(g, "You left the queue. Hope to see you another time!");
    this.signal(`${g.name} cancelled and left the queue`);
    this.event(`${g.name} cancelled and walked away`);
    this.recompute();
  }

  setJoins(open: boolean, by: string) {
    this.joinsPaused = !open;
    this.event(`${by} ${open ? "opened" : "closed"} the queue`, false);
    this.signal(`${by} ${open ? "opened" : "closed"} new joins`);
    if (open && this.scenario === "barber" && !this.scriptStarted) {
      // Opening the queue lets 6 walk-ins in over the next minutes.
      this.scriptStarted = true;
      [3, 5, 7, 9, 11, 13].forEach((m) => this.at(m, () => this.join({ swapOk: false, willNoShow: false })));
    }
  }

  private at(dt: number, run: () => void) { this.scheduled.push({ at: this.t + dt, run }); }

  // Barber woke the voice agent: the greeting happened, the clock still waits for the go-ahead.
  startDay() {
    if (this.dayStarted) return;
    this.dayStarted = true;
    if (this.scenario !== "barber") this.running = true;
  }

  // Barber gave the go-ahead: the clock runs and the scripted morning begins.
  go(openForMore: boolean) {
    if (this.running) return;
    this.dayStarted = true; this.running = true; this.speed = 1;
    if (this.scenario !== "barber") return;
    if (openForMore) { this.setJoins(true, this.barberName); [20, 40].forEach((m) => this.at(m, () => this.join({ away: false, swapOk: false, willNoShow: false, service: 30, expected: 30 }))); this.at(45, () => this.setJoins(false, "Hazel")); }
    const find = (n: string) => this.guests.find((g) => g.name === n);
    const start = this.t;
    const atClock = (hhmm: number, run: () => void) => this.at(hhmm - start, run);
    atClock(10 * 60 + 30, () => this.cancelFlow(find("Lina"), "cancelled", "Work came up, sorry!", "work came up", "tomorrow 10:00", "Max"));
    atClock(11 * 60 + 5, () => { const g = find("Ada"); if (g) this.setHurry(g.id); });
    atClock(12 * 60, () => this.cancelFlow(find("Omar"), "withdrew", "My kid got sick, sorry.", "kid got sick", "Thursday 14:00", "Zoe"));
  }

  agentMode: "AI" | "offline" = "offline"; // set by the agent, used to label scripted agent actions
  voiceHoldUntil = 0; // real-time ms: the clock pauses while the barber talks to Hazel

  // A booked client cancels: ask why, offer a new day, rebook, give the slot to the waitlist, tell the barber.
  private cancelFlow(g: Guest | undefined, verb: string, reply: string, shortWhy: string, rebook: string, standinName: string) {
    if (!g || g.status !== "waiting") return;
    const idx = this.line.indexOf(g.id);
    const slot = g.wait ? clock(this.t + g.wait[0]) : "";
    g.messages.push({ t: this.t, text: "I can't make it today, sorry.", kind: "guest", from: "guest" });
    g.status = "left"; g.endAt = this.t;
    this.recompute();
    const m = this.agentMode;
    const ask = `Sorry you can't make it, ${g.name}. Mind telling us why? Want to rebook for another day?`;
    g.messages.push({ t: this.t, text: ask, kind: "update", from: "agent" });
    this.log(m, "message_guest", `To ${g.name}: "${ask}"`, `${g.name} ${verb}: ask why and offer a new day`);
    this.at(1, () => {
      g.messages.push({ t: this.t, text: reply, kind: "guest", from: "guest" });
      const offer = `No worries, hope all is well! Does ${rebook} work for you?`;
      g.messages.push({ t: this.t, text: offer, kind: "update", from: "agent" });
      this.log(m, "message_guest", `To ${g.name}: "${offer}"`, `reason: ${shortWhy}; offer the next free slot`);
    });
    this.at(2, () => {
      g.messages.push({ t: this.t, text: "Yes, perfect.", kind: "guest", from: "guest" });
      const ok = `Booked: ${rebook}. See you then, ${g.name}!`;
      g.messages.push({ t: this.t, text: ok, kind: "update", from: "agent" });
      this.log(m, "rebook", `${g.name} rebooked for ${rebook}`, "guest said yes");
      const s2 = this.join({ name: standinName, away: true, walk: 8, swapOk: false, willNoShow: false, service: 30, expected: 30 }, this.t, true);
      this.line.splice(this.line.indexOf(s2.id), 1);
      this.line.splice(Math.max(0, Math.min(idx, this.line.length)), 0, s2.id);
      this.recompute();
      s2.messages.push({ t: this.t, text: `Good news ${standinName}: a slot opened${slot ? " around " + slot : ""} at Kiez Cuts. It's yours, see you soon!`, kind: "update", from: "agent" });
      this.log(m, "offer_slot", `Gave ${g.name}'s slot to ${standinName} from the waitlist`, "free slot, waitlist first");
      this.event(`${g.name} ${verb} (${shortWhy}), rebooked for ${rebook}; ${standinName} took the slot`, true,
        `Heads up ${this.barberName}: ${g.name} ${verb}, ${shortWhy}, rebooked for ${rebook}, and ${standinName} took the slot.`);
    });
  }

  // Minutes of work left for all chairs, and when the last client will be done.
  finishAt(extra = 0) {
    let work = 0;
    for (const g of this.guests) {
      if (g.status === "serving") work += Math.max(0, (g.endAt ?? 0) - this.t);
      if (g.status === "called") work += Math.max(0, (g.arriveAt ?? this.t) - this.t) + (g.expected ?? MEAN_SERVICE);
    }
    for (const id of this.line) work += this.get(id)?.expected ?? MEAN_SERVICE;
    work += extra * MEAN_SERVICE;
    return Math.round(this.t + work / Math.max(1, this.staff));
  }

  daySummary() {
    const today = this.guests.filter((g) => g.status !== "left" && g.status !== "noshow");
    return {
      now: clock(this.t), queueOpen: !this.joinsPaused, closingTime: clock(this.closeAt), barbers: this.staff,
      clientsToday: today.length, served: this.guests.filter((g) => g.status === "done").length,
      inChair: this.guests.filter((g) => g.status === "serving").map((g) => g.name),
      waiting: this.line.length, cancelled: this.guests.filter((g) => g.status === "left").length,
      noShows: this.guests.filter((g) => g.status === "noshow").length,
      cutMinutes: this.cutRange(), finishAround: clock(this.finishAt()), barberName: this.barberName,
      nextClient: this.get(this.line[0] ?? "")?.name ?? null,
      nextChairFreeInMin: this.nextChairFree(),
    };
  }

  private cutRange() {
    const cuts = this.guests.filter((g) => g.status === "waiting" || g.status === "called" || g.status === "serving").map((g) => g.expected ?? MEAN_SERVICE);
    return cuts.length ? [Math.min(...cuts), Math.max(...cuts)] : [MEAN_SERVICE, MEAN_SERVICE];
  }

  private nextChairFree() {
    const ends = this.guests.filter((g) => g.status === "serving").map((g) => (g.endAt ?? 0) - this.t);
    return ends.length < this.staff ? 0 : Math.max(0, Math.round(Math.min(...ends)));
  }

  capacity(extra: number) {
    const per = MEAN_SERVICE / Math.max(1, this.staff);
    const finish = this.finishAt(extra);
    const spare = Math.floor((this.closeAt - this.finishAt()) / per);
    return {
      extraClients: extra, closingTime: clock(this.closeAt), finishWithExtra: clock(finish),
      fits: finish <= this.closeAt, minutesOverOrUnder: Math.round(finish - this.closeAt),
      spareSlotsBeforeClose: Math.max(0, spare), clientsToday: this.daySummary().clientsToday,
    };
  }

  // Proactive voice: when a cut finishes, briefly tell the barber what happened meanwhile.
  private betweenCuts() {
    if (!this.voiceMode) return;
    const news = this.events.slice(this.spokenCursor).filter((e) => e.notable).map((e) => e.text);
    this.spokenCursor = this.events.length;
    const next = this.get(this.line[0] ?? "");
    const parts = [`${this.barberName}, heads up:`];
    if (news.length) parts.push(news.slice(-2).join(". ") + ".");
    if (!news.length) return;
    if (next) parts.push(`${next.name} is next.`);
    this.say("agent", parts.join(" "), true);
  }

  recentEvents() {
    const fresh = this.events.slice(this.eventsCursor);
    this.eventsCursor = this.events.length;
    this.spokenCursor = this.events.length; // the barber just heard it; don't repeat it between cuts
    const out = fresh.filter((e) => e.notable).map((e) => `${clock(e.t)} ${e.text}`);
    const joins = fresh.filter((e) => e.text.endsWith("joined the queue")).length;
    if (joins) out.push(`${clock(this.t)} ${joins} new walk-ins joined`);
    return out.length ? out : ["nothing new"];
  }

  get(id: string) { return this.guests.find((g) => g.id === id); }

  signal(s: string) { this.signals.push(`${clock(this.t)} ${s}`); }

  log(mode: Activity["mode"], tool: string, text: string, reason: string) {
    this.activity.unshift({ t: this.t, mode, tool, text, reason });
    if (this.activity.length > 200) this.activity.pop();
  }

  private sys(g: Guest, text: string) { g.messages.push({ t: this.t, text, kind: "info", from: "system" }); }

  rush() {
    const specs: Partial<Guest>[] = [{}, { willNoShow: true }, { swapOk: true }, {}, { willNoShow: true }, { swapOk: true }, {}, {}];
    specs.forEach((opts, i) => this.pendingJoins.push({ at: this.t + i * 0.6, opts }));
    // one guest in a hurry joins mid-rush
    this.pendingJoins.push({ at: this.t + 3, opts: { hurry: true, swapOk: false, away: false } });
    this.log("sim", "rush", "Rush started: 9 guests about to join", "demo button");
  }

  setHurry(id: string) {
    const g = this.get(id);
    if (!g || g.hurry) return;
    g.hurry = true; g.swapOk = false;
    this.signal(`${g.name} tapped "I'm in a hurry"`);
  }

  setSwapOk(id: string) {
    const g = this.get(id);
    if (!g || g.swapOk) return;
    g.swapOk = true;
    this.signal(`${g.name} said they are happy to swap to a later place`);
  }

  // ---- actions the agent (or offline rules) can take ----

  messageGuest(id: string, kind: string, text: string) {
    const g = this.get(id);
    if (!g || g.status === "done" || g.status === "noshow") return "error: guest not in line";
    if (kind !== "update" && g.notified.includes(kind)) return `error: already sent ${kind} to ${g.name}`;
    g.messages.push({ t: this.t, text, kind, from: "agent" });
    g.notified.push(kind);
    if (kind === "head_back_now" && g.away && g.headedBackAt === undefined) {
      g.headedBackAt = this.t;
      if (g.status === "called" && !g.willNoShow) g.arriveAt = Math.min(g.arriveAt ?? Infinity, this.t + g.walk);
    }
    return `sent to ${g.name}`;
  }

  proposeSwap(a: string, b: string) {
    const ga = this.get(a), gb = this.get(b);
    if (!ga || !gb || ga.status !== "waiting" || gb.status !== "waiting") return "error: both guests must be waiting";
    if (this.line.indexOf(gb.id) > this.line.indexOf(ga.id)) return "error: partner must be ahead of the hurried guest";
    if (this.swaps.some((s) => s.status === "proposed" && (s.a === a || s.b === b))) return "error: swap already pending";
    this.swaps.push({ id: this.nextSwapId++, a, b, t: this.t, status: "proposed" });
    return `swap proposed between ${ga.name} and ${gb.name}; ${gb.name} will answer soon`;
  }

  markNoShow(id: string) {
    const g = this.get(id);
    if (!g || g.status !== "called") return "error: only a called guest can be marked no-show";
    if (this.t - (g.calledAt ?? this.t) < 3) return "error: give them at least 3 minutes";
    g.status = "noshow"; g.endAt = this.t;
    this.event(`${g.name} did not show up, the line moved up`);
    this.sys(g, "We called you but you did not arrive, so your place was released. Scan the QR again to rejoin.");
    this.recompute();
    return `${g.name} marked no-show; next guest called`;
  }

  alertOwner(text: string, reason: string, action: string) {
    const recent = this.alerts.find((a) => a.action === action && (a.status === "open" || (action !== "none" && this.t - a.t < 15)));
    if (recent) return "error: a similar alert was sent less than 15 minutes ago";
    this.alerts.unshift({ id: this.nextAlertId++, t: this.t, text, reason, action, status: "open" });
    return "owner alerted";
  }

  ownerRespond(id: number, apply: boolean) {
    const a = this.alerts.find((x) => x.id === id);
    if (!a || a.status !== "open") return;
    a.status = apply ? "applied" : "dismissed";
    if (apply) {
      if (a.action === "pause_joins") this.joinsPaused = true;
      if (a.action === "add_staff") this.staff = Math.min(4, this.staff + 1);
      if (a.action === "resume_joins") this.joinsPaused = false;
    }
    this.log("sim", "owner", `Owner ${apply ? "applied" : "dismissed"}: ${a.text}`, "owner tapped a button");
    this.signal(`Owner ${apply ? "accepted" : "dismissed"} alert "${a.action}"`);
  }

  // ---- simulation ----

  step(dt: number) {
    if (!this.running || this.dayClosed || Date.now() < this.voiceHoldUntil) return;
    this.t += dt;
    const r = this.rand;

    for (const p of [...this.pendingJoins]) {
      if (p.at <= this.t) { this.pendingJoins.splice(this.pendingJoins.indexOf(p), 1); this.join(p.opts); }
    }
    for (const s of [...this.scheduled]) {
      if (s.at <= this.t) { this.scheduled.splice(this.scheduled.indexOf(s), 1); s.run(); }
    }
    if (this.scenario === "demo" && !this.joinsPaused && r() < 0.06 * dt) this.join({ willNoShow: r() < 0.1 });

    for (const g of this.guests) {
      if (g.status === "serving" && this.t >= (g.endAt ?? 0)) { g.status = "done"; this.event(`${g.name} is done`, false); this.betweenCuts(); }
      if (g.status === "called") {
        if (!g.willNoShow && this.t >= (g.arriveAt ?? 0)) {
          g.status = "serving"; g.startAt = this.t; g.endAt = this.t + g.service;
        } else {
          this.idleChairMin += dt;
          const late = this.t - (g.calledAt ?? 0);
          if (late >= 5 && !g.notified.includes("_late")) { g.notified.push("_late"); this.signal(`${g.name} was called ${Math.round(late)} min ago and has not arrived`); }
          if (late >= NO_SHOW_FAILSAFE) {
            g.status = "noshow"; g.endAt = this.t;
            this.log("sim", "failsafe", `${g.name} auto-removed after ${NO_SHOW_FAILSAFE} min`, "nobody acted on the no-show");
          }
        }
      }
    }

    for (const s of this.swaps) {
      if (s.status === "proposed" && this.t - s.t >= 1.5) {
        const ga = this.get(s.a)!, gb = this.get(s.b)!;
        if (gb.status !== "waiting" || ga.status !== "waiting") { s.status = "declined"; continue; }
        if (gb.swapOk) {
          s.status = "accepted";
          const ia = this.line.indexOf(ga.id), ib = this.line.indexOf(gb.id);
          this.line[ia] = gb.id; this.line[ib] = ga.id;
          this.sys(ga, `${gb.name} agreed. You moved up to place ${ib + 1}.`);
          this.sys(gb, `Thanks! You are now place ${ia + 1}. We'll message you before your turn.`);
          this.log("sim", "swap", `${gb.name} accepted the swap with ${ga.name}`, "guest tapped accept");
          this.event(`${gb.name} swapped with ${ga.name}${ga.hurry ? `, ${ga.name} was in a hurry` : ""}`, true,
            this.scenario === "barber" ? `Heads up ${this.barberName}: ${ga.name} was in a hurry, so ${gb.name} let ${ga.name} go first.` : undefined);
          this.signal(`${gb.name} accepted the swap; ${ga.name} is now place ${ib + 1}`);
        } else {
          s.status = "declined";
          this.signal(`${gb.name} declined the swap with ${ga.name}`);
        }
      }
    }

    this.recompute();
  }

  private callNext() {
    const busy = this.guests.filter((g) => g.status === "serving" || g.status === "called").length;
    let free = this.staff - busy;
    while (free > 0 && this.line.length) {
      const g = this.get(this.line.shift()!)!;
      g.status = "called"; g.calledAt = this.t;
      const arrive = g.away ? (g.headedBackAt !== undefined ? g.headedBackAt + g.walk : this.t + g.walk) : this.t + 0.5;
      g.arriveAt = Math.max(this.t + 0.5, arrive);
      this.sys(g, "It's your turn now. Please come to the counter.");
      free--;
    }
  }

  recompute() {
    this.line = this.line.filter((id) => this.get(id)?.status === "waiting");
    this.callNext();
    const chairs: number[] = [];
    for (const g of this.guests) {
      if (g.status === "serving") chairs.push(Math.max(0, (g.endAt ?? 0) - this.t));
      if (g.status === "called") chairs.push(Math.max(0, (g.arriveAt ?? this.t + g.walk) - this.t) + (g.expected ?? MEAN_SERVICE));
    }
    while (chairs.length < this.staff) chairs.push(0);
    chairs.sort((a, b) => a - b);
    const used = chairs.slice(0, Math.max(this.staff, 1)).map((c) => ({ c, k: 0 }));
    for (const id of this.line) {
      const g = this.get(id)!;
      used.sort((a, b) => a.c - b.c);
      const ch = used[0];
      const k = ch.k + 1;
      g.wait = [Math.max(0, Math.round(ch.c - 1.5 * k)), Math.round(ch.c + 2 + 2.5 * k)];
      ch.c += g.expected ?? MEAN_SERVICE; ch.k = k;
    }
  }

  backlog() {
    const last = this.get(this.line[this.line.length - 1] ?? "");
    return last?.wait?.[1] ?? 0;
  }

  stats() {
    const done = this.guests.filter((g) => g.status === "done" || g.status === "serving");
    const waits = done.filter((g) => g.startAt !== undefined).map((g) => (g.startAt as number) - g.joinedAt);
    return {
      served: this.guests.filter((g) => g.status === "done").length,
      inChair: this.guests.filter((g) => g.status === "serving").length,
      waiting: this.line.length,
      noShows: this.guests.filter((g) => g.status === "noshow").length,
      swaps: this.swaps.filter((s) => s.status === "accepted").length,
      messages: this.guests.reduce((n, g) => n + g.messages.filter((m) => m.from === "agent").length, 0),
      avgWait: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0,
      idleChairMin: Math.round(this.idleChairMin),
      backlog: this.backlog(),
    };
  }

  // Compact view for the model: no hidden fields (willNoShow, service).
  agentView() {
    const row = (g: Guest) => {
      const o: Record<string, unknown> = { id: g.id, name: g.name, st: g.status };
      if (g.status === "waiting") { o.place = this.line.indexOf(g.id) + 1; o.wait = g.wait; }
      if (g.status === "called") o.calledMinAgo = Math.round(this.t - (g.calledAt ?? this.t));
      o.where = g.away ? (g.headedBackAt !== undefined ? "walking back" : `away, ${g.walk} min walk`) : "in shop";
      if (g.hurry) o.hurry = true;
      if (g.swapOk) o.swapOk = true;
      if (g.notified.length) o.sent = g.notified.filter((n) => !n.startsWith("_"));
      return o;
    };
    return {
      now: clock(this.t),
      staff: this.staff,
      joinsPaused: this.joinsPaused,
      backlogMin: this.backlog(),
      noShowsLast30: this.guests.filter((g) => g.status === "noshow" && this.t - (g.calledAt ?? 0) < 30).length,
      called: this.guests.filter((g) => g.status === "called").map(row),
      line: this.line.map((id) => row(this.get(id)!)),
      pendingSwaps: this.swaps.filter((s) => s.status === "proposed").map((s) => `${s.a}<->${s.b}`),
      openOwnerAlerts: this.alerts.filter((a) => a.status === "open").map((a) => a.action),
    };
  }
}
