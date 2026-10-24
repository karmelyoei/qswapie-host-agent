// Simulated walk-in queue. All guests are fake; nothing talks to QSwapie.

export type Status = "waiting" | "called" | "serving" | "done" | "noshow" | "left" | "booked";

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
  svc?: string; // booked service, e.g. "skin fade"
  slotAt?: number; // booked start time (sim minutes)
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

// Morning shift: 10 clients, done at 17:00. Paul is in the chair, Alex and Tobi are waiting, the rest are booked later.
const DAY: { name: string; svc: string; dur: number; at?: number }[] = [
  { name: "Paul", svc: "classic cut", dur: 45 },
  { name: "Alex", svc: "skin fade", dur: 40 },
  { name: "Tobi", svc: "beard trim and line-up", dur: 30 },
  { name: "Sara", svc: "kids cut", dur: 30, at: 11 * 60 },
  { name: "Jonas", svc: "fade and beard", dur: 50, at: 11 * 60 + 30 },
  { name: "Lina", svc: "cut and wash", dur: 40, at: 13 * 60 },
  { name: "Emma", svc: "buzz cut", dur: 25, at: 13 * 60 + 40 },
  { name: "Omar", svc: "skin fade", dur: 40, at: 14 * 60 + 10 },
  { name: "Ben", svc: "classic cut", dur: 45, at: 15 * 60 },
  { name: "Ida", svc: "cut and style", dur: 45, at: 16 * 60 + 15 },
];
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
      // The clock waits for the barber's go-ahead by voice; the day's events are scripted so every run is the same.
      this.names = MORNING_NAMES;
      this.t = 9 * 60; this.staff = 1; this.joinsPaused = true; this.voiceMode = true; this.running = false;
      if (!close) this.closeAt = 17 * 60 + 30;
      const mk = (d: (typeof DAY)[number]) => this.makeGuest({ name: d.name, svc: d.svc, service: d.dur, expected: d.dur, away: false, swapOk: false, willNoShow: false, hurry: false, slotAt: d.at });
      const paul = mk(DAY[0]); paul.joinedAt = 8 * 60 + 50; paul.status = "serving"; paul.startAt = 8 * 60 + 55; paul.endAt = paul.startAt + paul.service;
      this.guests.push(paul);
      for (const d of DAY.slice(1, 3)) { const g = mk(d); g.joinedAt = 8 * 60 + 50; this.guests.push(g); this.line.push(g.id); g.messages.push({ t: this.t, text: `You're checked in at Kiez Cuts for a ${d.svc}.`, kind: "info", from: "system" }); }
      for (const d of DAY.slice(3)) { const g = mk(d); g.status = "booked"; g.joinedAt = 8 * 60; this.guests.push(g); g.messages.push({ t: this.t, text: `Booked at Kiez Cuts: ${d.svc} at ${clock(d.at!)}.`, kind: "info", from: "system" }); }
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

  // Barber spoke for the first time: Hazel greeted, the clock still waits for the go-ahead.
  startDay() {
    if (this.dayStarted) return;
    this.dayStarted = true;
    if (this.scenario !== "barber") this.running = true;
  }

  agentMode: "AI" | "offline" = "offline"; // set by the agent, used to label scripted agent actions
  voiceHoldUntil = 0; // real-time ms: the clock pauses while the barber talks to Hazel
  awaiting: "" | "lina" = ""; // Hazel asked the barber a question and the clock waits for the answer

  // Barber gave the go-ahead: the clock runs and the scripted day begins.
  go(addMore: boolean) {
    if (this.running) return;
    this.dayStarted = true; this.running = true; this.speed = 1;
    if (this.scenario !== "barber") return;
    if (addMore) this.setJoins(true, this.barberName);
    this.at(10 * 60 + 30 - this.t, () => this.linaCancels());
  }

  private agentSays(g: Guest, text: string, reason: string, tool = "message_guest") {
    g.messages.push({ t: this.t, text, kind: "update", from: "agent" });
    this.log(this.agentMode, tool, `To ${g.name}: "${text}"`, reason);
  }
  private guestSays(g: Guest, text: string) { g.messages.push({ t: this.t, text, kind: "guest", from: "guest" }); }

  // 10:30 Lina cancels her 13:00 booking: ask why, rebook, then pause and ask the barber what to do with the slot.
  private linaCancels() {
    const g = this.guests.find((x) => x.name === "Lina");
    if (!g || g.status !== "booked") return;
    this.guestSays(g, "Sorry, I can't make it at 1 today.");
    g.status = "left"; g.endAt = this.t;
    this.signal("Lina cancelled her 13:00 booking");
    this.agentSays(g, "Sorry you can't make it, Lina. Mind telling us why? Want to rebook for another day?", "Lina cancelled: ask why and offer a new day");
    this.at(1, () => {
      this.guestSays(g, "Work came up, sorry!");
      this.agentSays(g, "No worries, hope work goes well! Does tomorrow at 10:00 work for you?", "reason: work came up; offer the next free slot");
    });
    this.at(2, () => {
      this.guestSays(g, "Yes, perfect.");
      this.agentSays(g, "Booked: tomorrow 10:00. See you then, Lina!", "guest said yes", "rebook");
      this.event("Lina cancelled her 1 pm (work came up), rebooked for tomorrow 10:00", true);
      this.running = false; this.awaiting = "lina"; // the clock waits for the barber's decision
      this.say("agent", `Heads up ${this.barberName}: Lina cancelled for 1 pm, work came up, rebooked for tomorrow. Should I open her spot for someone new, or move everyone up a slot and finish earlier?`, true);
      this.spokenCursor = this.events.length;
    });
  }

  // Barber's answer about Lina's slot.
  decideLina(choice: "new" | "moveup") {
    if (this.awaiting !== "lina") return "";
    this.awaiting = ""; this.running = true;
    if (choice === "new") {
      const max = this.makeGuest({ name: "Max", svc: "cut and wash", service: 40, expected: 40, away: false, swapOk: false, willNoShow: false, hurry: false, slotAt: 13 * 60 });
      max.status = "booked"; max.joinedAt = this.t; this.guests.push(max);
      this.agentSays(max, "Hi Max, a 1 pm slot just opened at Kiez Cuts. Want it?", "barber: offer Lina's slot to the waitlist", "offer_slot");
      this.at(1, () => {
        this.guestSays(max, "Yes please!");
        this.agentSays(max, "Booked: today at 1 pm, cut and wash. See you then!", "Max accepted", "rebook");
        this.event("Max took the 1 pm slot from the waitlist", true, `Good news ${this.barberName}: Max from the waitlist took the 1 pm slot.`);
      });
      return `On it, offering the 1 pm slot to the waitlist.`;
    }
    const later = this.guests.filter((x) => x.status === "booked" && (x.slotAt ?? 0) > 13 * 60);
    for (const x of later) {
      x.slotAt = (x.slotAt ?? 0) - 40;
      this.agentSays(x, `Good news ${x.name}: you can come 40 minutes earlier, at ${clock(x.slotAt)}.`, "barber moved everyone up a slot", "reschedule");
    }
    this.event(`Everyone after 1 pm moved up 40 minutes`, false);
    return `Done: everyone after one moves up forty minutes, so you'll finish around ${clock(this.finishAt())}.`;
  }

  // Minutes of work left for all chairs, and when the last client will be done.
  finishAt(extra = 0) {
    let T = this.t;
    const serving = this.guests.filter((g) => g.status === "serving").map((g) => g.endAt ?? this.t);
    if (serving.length >= this.staff) T = Math.min(...serving);
    for (const g of this.guests) if (g.status === "called") T = Math.max(T, g.arriveAt ?? this.t) + (g.expected ?? MEAN_SERVICE);
    for (const id of this.line) { const g = this.get(id)!; T = Math.max(T, g.slotAt ?? 0) + (g.expected ?? MEAN_SERVICE); }
    const booked = this.guests.filter((g) => g.status === "booked").sort((a, b) => (a.slotAt ?? 0) - (b.slotAt ?? 0));
    for (const g of booked) T = Math.max(T, g.slotAt ?? 0) + (g.expected ?? MEAN_SERVICE);
    if (this.staff > 1) T = this.t + (T - this.t) / this.staff;
    return Math.round(T + extra * 35);
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
      waitingNames: this.line.map((id) => { const g = this.get(id)!; return g.svc ? `${g.name} (${g.svc})` : g.name; }),
      bookedLater: this.guests.filter((g) => g.status === "booked").map((g) => `${clock(g.slotAt ?? 0)} ${g.name}`),
      awaitingDecision: this.awaiting || null,
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
    for (const g of this.guests) {
      if (g.status === "booked" && g.slotAt !== undefined && this.t >= g.slotAt - 5) {
        g.status = "waiting"; this.line.push(g.id);
        g.messages.push({ t: this.t, text: `You're checked in for your ${g.svc ?? "cut"}.`, kind: "info", from: "system" });
        this.event(`${g.name} checked in for ${g.svc}`, false);
      }
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
