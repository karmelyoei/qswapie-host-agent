# QSwapie Host Agent

**A proactive AI host for walk-in venues, with a hands-free voice sidekick for the barber.**

Walk-in waiting is dead time: guests stand around or walk away, and chairs sit idle when the next guest isn't there. QSwapie Host Agent runs the queue for the venue *on its own*. A Claude agent watches the live line, gives every guest an honest wait range, tells people when to come back, flags no-shows, arranges swaps for guests in a hurry and warns the owner before things go wrong. At the chair, the barber talks to **Fade**, a voice agent built on **Reson8** live speech-to-text and **Claude**. Fade greets the barber, answers "how's today looking?", reports cancellations between cuts and does the capacity math for "can we take two more?", all hands-free.

Built at **Agentic AI Hack by Jamie** ({Tech: Europe}, Berlin, 2026-10-24), Open Agentic Track. Partner tech: **Anthropic** (Claude Sonnet 5.5, tool use) and **Reson8** (Turns speech-to-text).

> Screenshots: `docs/screenshots/` *(placeholder: queue page, barber page)*

## What it does

**Page 1: the queue agent** (`http://localhost:5173/`)
1. Predicts each guest's wait as an **honest range** (e.g. 12 to 20 min), not a fake single number.
2. **Messages guests proactively**: "no rush, about 35 to 50 min" or "head back now", timed to each guest's walk-back distance.
3. **Flags no-shows** and moves the line up.
4. **Hurry swaps**: when a guest taps "I'm in a hurry", it finds a guest ahead who is happy to swap and proposes it to both.
5. **Alerts the owner**: "queue is 50 min deep, pause new joins?", "2 no-shows in 30 min", plus an end-of-day summary.
6. Every action appears in the **agent activity feed** with a one-line reason and a badge: *Claude* or *Offline rules*.

**Page 2: the barber voice page** (`http://localhost:5173/barber`)
- Big orb mic, live transcript, natural voice output, mute, voice picker, closing time, typed fallback.
- **Start day**: Fade greets the barber (Nico) proactively with today's numbers.
- Voice commands with tools: open or close the queue, today's summary, finish time, capacity check ("2 more?"), recent events.
- **Between cuts**, Fade proactively reports news: "Nico, heads up: Lina walked away, Ben swapped with Ada."

Both pages run on the **same live simulation**, so they can sit side by side on stage.

## Quick start

Requires **Node.js 24+** (TypeScript runs directly through Node's type stripping, so there is no build step).

**Windows (PowerShell)**: both keys are typed hidden and live only in this window.
```powershell
npm install
$a = Read-Host 'Anthropic key' -AsSecureString; $r = Read-Host 'Reson8 key' -AsSecureString; $env:ANTHROPIC_API_KEY = [Net.NetworkCredential]::new('', $a).Password; $env:RESON8_API_KEY = [Net.NetworkCredential]::new('', $r).Password; npm start
```

**macOS / Linux (bash)**
```bash
npm install
read -rs -p "Anthropic key: " ANTHROPIC_API_KEY; echo; read -rs -p "Reson8 key: " RESON8_API_KEY; echo; export ANTHROPIC_API_KEY RESON8_API_KEY; npm start
```

Or copy `.env.example` to `.env` (gitignored) and fill it in, then run `npm start`.

Open **two browser windows side by side**, ideally in **Microsoft Edge** (its "Natural" neural voices sound human; Chrome works too):
- left: http://localhost:5173/ (queue agent)
- right: http://localhost:5173/barber (barber voice)

No keys? It still runs: see [Fallbacks](#fallbacks).

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Claude for the queue agent and Fade. Without it: offline rules |
| `RESON8_API_KEY` | none | Reson8 live speech-to-text. Without it: browser speech recognition |
| `BARBER_NAME` | `Nico` | The barber's name in the voice page and Fade's lines |
| `CLOSE_TIME` | `19:00` | Shop closing time for the capacity checks (also editable on the page) |
| `PORT` | `5173` | HTTP port |
| `AGENT_MAX_CALLS` | `150` | Hard cap on Claude calls per server run |

Keys are read only by the server and never sent to the browser or written to logs.

## 2-minute demo script

**Part 1: the barber and Fade (about 90 s), on `/barber`**
1. Click **Restart day** if needed. It's 15:30, Nico has 1 client in the chair and 9 booked, and the queue is closed for walk-ins. The clock waits for Nico.
2. Tap **Start day**. Fade greets proactively: *"Hey Nico, what's up? Today's gonna be packed: you've got 10 heads booked, first one in 5 minutes, you'll be done around twenty-five past five."* The mic opens.
3. Say: *"Beautiful morning! Let's optimise today, open the queue."* Fade opens it, and walk-ins start appearing on the queue page.
4. Say: *"How's today looking?"* You get the real numbers from the simulation.
5. After a few seconds, say: *"Anything new?"* Fade: *"Ben swapped with Ada, Ada was in a hurry. Lina cancelled and walked away."* (When a cut finishes, Fade also says it unprompted.)
6. Say: *"We've got 15 now. Should we close the queue for today, or do we have the power for 2 more?"* Fade runs the capacity check against the 19:00 closing time and answers with a finish time and a joke.
7. Say: *"Close it."* The queue closes; everyone already in line keeps their place.

**Part 2: the queue agent (about 30 s), on `/`**
1. Point at the activity feed: every action has a *Why* and a *Claude* badge.
2. Click a guest card to see their phone, with the wait range and the agent's messages.
3. For the busy two-barber day, click **Reset** and then **Simulate rush**: watch head-back timing, no-shows, a hurry swap and the owner alert "pause new joins?". **End of day** writes a summary.

Speed buttons (0.5x to 4x) control sim minutes per real second. Add `?voice=off` to the barber URL to keep Fade silent.

## How it works

```
browser /barber ──mic PCM──▶ Node /stt ──▶ Reson8 Turns (WebSocket)
                ◀─turn events─┘
        └─ final text ─▶ POST /api/action ─▶ Claude (voice tools) ─▶ reply ─▶ speechSynthesis

simulation (engine.ts) ──signals──▶ agent loop (agent.ts) ──tool calls──▶ simulation
          └──────────── GET /api/state (both pages, ~2x per second) ────────────┘
```

- **Proactive loop**: the simulation raises signals (joins, hurry taps, late guests, guests near the front, deep backlog, no-shows). At most every 5 s, and only if something changed, the agent sends Claude a compact JSON snapshot with six tools (`get_queue`, `predict_wait`, `message_guest`, `propose_swap`, `mark_no_show`, `alert_owner`). Every action tool requires a `reason`.
- **Voice**: the browser streams 16 kHz mono PCM over a WebSocket to the server, which proxies it to Reson8 Turns with the key added server-side. On `turn_end`, the transcript goes to Claude with six voice tools (`day_summary`, `estimate_finish`, `capacity_check`, `open_queue`, `close_queue`, `recent_events`). The short reply (at most 2 sentences) is spoken sentence by sentence; the mic pauses while Fade talks.
- **Guards**: the engine validates every action (no double messages, no early no-shows, no duplicate alerts). The hidden truth of the simulation (who will no-show, real cut lengths) is never shown to the agent.

Full details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (diagrams, triggers, fallbacks, cost guards, key security) and [docs/APIS-AND-TOOLS.md](docs/APIS-AND-TOOLS.md) (every API, tool schema, framework and dependency).

### Fallbacks

The demo never dies on stage:
- **Claude** down, slow or without a key: offline rules take over (orange label) and Claude is retried after 15 s. Labels show the real cause: `timeout`, `network`, or `API 4xx: message`.
- **Reson8** missing or failing: the browser Web Speech API takes over. No mic at all: the typed box.
- **Text to speech**: browser `speechSynthesis`, preferring Natural neural voices.

### Cost guards

`claude-sonnet-5-5`, effort `low`; `max_tokens` 1200 (queue agent) and 300 (voice); at most one agent run per 5 s and only on change; at most 2 requests per run and 4 per voice turn; `AGENT_MAX_CALLS` cap; 30 s timeout with 1 retry. The call counter and tokens are shown on screen, and every call's duration is logged on the server console.

## Tech stack

Node.js 24 (`http`, `fs`, built-in TypeScript type stripping, `process.loadEnvFile`), TypeScript, `@anthropic-ai/sdk`, `ws`, plain HTML/CSS/JS (no framework), browser Web Speech API. External services: Anthropic Messages API, Reson8 Turns. No database and no deploy: everything runs locally.

## Project layout

```
src/engine.ts   queue simulation (seeded), wait ranges, events, barber scenario, capacity math
src/agent.ts    Claude agent loop + tools, voice agent (Fade), offline rules, failure handling
src/server.ts   HTTP server, /api/state, /api/action, /stt WebSocket proxy to Reson8, page routes
public/index.html   queue page (/ and /guests)
public/barber.html  barber voice page (/barber)
public/voice.js     mic capture, Reson8 / Web Speech, speech output, voice picker
docs/               architecture and API documentation
pitch/              pitch and submission outlines
```

## Built today vs existed before

- **Existed before**: QSwapie, the founder's digital queue product for walk-in venues (QR code, live place, wait anywhere, trade places). Its code lives in a separate repository and was **not** changed or connected.
- **Built at the hackathon on 2026-10-24**: everything in this repository: the proactive queue agent and its tools, the barber voice agent (Reson8 proxy, voice tools, persona, speech output), the offline fallbacks, the queue simulation and demo data, both web pages, the docs and the pitch outlines.
- All guests are **simulated** with fake first names. No real people, no real venue data, no payments.

## License

MIT, see [LICENSE](LICENSE).
