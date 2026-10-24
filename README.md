# QSwapie Host Agent

A proactive AI host for a walk-in venue (here: a barbershop called Kiez Cuts) that runs on the QSwapie digital queue idea.
Nobody prompts it. It watches the live queue and acts on its own:

1. **Predicts each guest's wait as an honest range** (for example 12 to 20 min), not a fake single number.
2. **Messages guests proactively**: "no rush, about 30 to 45 min" for guests far back, "head back now" timed to each guest's walk-back distance, and it flags no-shows so the line moves up.
3. **Handles "I'm in a hurry"**: finds a guest ahead who said they are happy to swap and proposes the swap to both (no money in this demo).
4. **Alerts the owner**: "queue is 50 min deep, pause new joins?", "2 no-shows in 30 min", "queue is short again, open joins?", plus an end-of-day summary.

Every action shows up in the **Agent activity** feed with a one-line reason.

Built for the *Agentic AI Hack by Jamie* ({Tech: Europe}, Berlin, 2026-10-24), Open Agentic Track.

## Start (one command)

Needs Node 24 or newer.

```bash
npm install && npm start
```

Open http://localhost:5173

**With Claude and Reson8** (PowerShell, from this folder; both keys are typed hidden and only live in that window):

```powershell
$a = Read-Host 'Anthropic key' -AsSecureString; $r = Read-Host 'Reson8 key' -AsSecureString; $env:ANTHROPIC_API_KEY = [Net.NetworkCredential]::new('', $a).Password; $env:RESON8_API_KEY = [Net.NetworkCredential]::new('', $r).Password; npm start
```

Or put `ANTHROPIC_API_KEY=...` and `RESON8_API_KEY=...` in a local `.env` file (gitignored, see `.env.example`). Run the demo in **Microsoft Edge**: on Windows it has the human-sounding "Natural" neural voices, which Fade picks automatically (Chrome works too, with Google voices). Pick another voice in the Voice dropdown of the voice panel; the choice is remembered. Add `?voice=off` to the URL to keep Fade silent, for example when testing.

Every part has a fallback, so the demo never dies on stage:
- No Anthropic key, or the API fails: **Offline rules** mode (orange label). It retries Claude after 60 seconds.
- No Reson8 key, or Reson8 fails: the browser's own speech recognition. No mic at all: the typed box under the voice panel.
- `CLOSE_TIME=19:00` (env) or the Closing field in the voice panel sets the shop's closing time.

## 2-minute demo script

### Part 1: Barber voice mode (about 90 s)

The barber is cutting hair and talks to the agent, "Fade", hands-free. Fade answers out loud, while the guest-messaging agent keeps working in the background.

1. Click **Barber day** (resets to 15:30, one barber, queue closed, closing time 19:00). The middle panel becomes **Barber voice**. Speed **1x**.
2. Tap the big **mic** and say: *"Beautiful morning! Let's optimise today, open the queue."* Fade opens the queue and confirms. Walk-ins start appearing on the left.
3. Say: *"How's today looking?"* Fade: you have 10 clients today and gives the finish time at this pace (real numbers from the simulation).
4. Wait a few seconds (Ada taps "in a hurry", Lina cancels). Say: *"Anything new?"* Fade: Lina cancelled and walked away, Ben swapped with Ada because Ada was in a hurry. When a cut finishes, Fade also reports news by itself, briefly ("between cuts").
5. About 20 seconds after opening, six more walk-ins have joined (15 clients today). Say: *"We've got 15 now. Should we close the queue for today, or do we have the power for 2 more?"* Fade runs a capacity check against the 19:00 closing time and answers with the finish time, plus a joke.
6. Say: *"Close it."* Fade closes the queue. People already in line stay.

While Fade talks, the mic pauses (no echo). **Voice on/off** mutes the speech. The label next to the panel title shows which speech-to-text is live: Reson8, browser speech, or typed only.

### Part 2: The guest-messaging agent (about 30 s)

Click **🎙 Barber voice** to switch the middle panel back to the guest phone, or click **Reset** for the busy two-barber demo below.

1. Open http://localhost:5173. Point at the top bar: clock, **Claude live** label, model, calls and token counter.
2. Left panel: the live queue. Each card shows place, wait range, where the guest is ("away, 6 min walk"), and tags.
3. Click **Simulate rush**. Nine guests join over a few minutes, two of them will never show up, one is in a hurry.
4. Watch the **Agent activity** feed on the right: Claude messages guests far back ("no rush, about 35 to 50 min"), tells guests near the front to head back now, and every line says *Why*.
5. Click a guest card on the left to see **their phone** in the middle: their place, wait range and the messages the agent sent.
6. Hurry swap: the hurry guest from the rush (red **hurry** tag) gets a swap proposal. Or pick any guest far back and tap **I'm in a hurry** on their phone. The agent asks a guest ahead with **swap ok**; about 1.5 minutes later the swap happens and both phones update.
7. No-shows: a called guest (yellow **called** tag) who does not arrive gets marked no-show by the agent after about 5 minutes and the next guest is called. Two of them trigger an owner alert.
8. Owner alert: when the queue gets deep the owner gets "Pause new joins?" with a button. Click it. Later the agent suggests opening joins again.
9. Click **End of day**: Claude writes the owner a short summary (served, no-shows, swaps, idle chair minutes, one tip for tomorrow).

Use the **0.5x / 1x / 2x / 4x** speed buttons (sim minutes per real second). 1x or 2x works best on stage. **Reset** restarts the same seeded day.

The stat to point at: **idle chair** minutes, the time a barber waits for a guest who was called but was not told early enough to walk back.

## How it works

- `src/engine.ts`: seeded queue simulation (fake first names, service times, walk-back distances, hidden no-shows). Wait prediction assigns guests to the next free chair and widens the range the further back a guest is.
- `src/agent.ts`: the agent. Every second it checks for new signals (joins, hurry taps, late guests, a guest getting close to the front, a deep backlog). If there is something new, it sends Claude (`claude-sonnet-5-5`, effort `low`, max 1200 output tokens) a compact JSON snapshot and these tools:
  `get_queue`, `predict_wait`, `message_guest`, `propose_swap`, `mark_no_show`, `alert_owner`. Each action tool requires a `reason`, which is what the feed shows.
  The engine guards every action (no double messages, no-show only after 3 min, no duplicate open alerts).
- Token budget: at most one Claude run per 5 real seconds and only when something changed, at most 2 requests per run, hard cap of 150 calls per server run (`AGENT_MAX_CALLS` to change). The counter is on screen.
- Offline rules: the same goals as fixed rules with template messages, used when there is no key, the API errors, or the budget is used up.
- `src/server.ts`: plain Node HTTP server, `/api/state` and `/api/action`, serves `public/index.html`. The UI polls twice a second.
- Barber voice mode: the browser sends 16 kHz mono PCM audio over a WebSocket to `/stt` on this server, which proxies it to the Reson8 **Turns** endpoint (`wss://api.reson8.dev/v1/speech-to-text/turns`, English) with the key added server-side, so the key never reaches the browser. On `turn_end` the final transcript goes to the same Claude agent with voice tools: `day_summary`, `estimate_finish`, `capacity_check`, `open_queue`, `close_queue`, `recent_events`. Answers are capped at 2 spoken sentences and read out with the browser's `speechSynthesis`. Offline, keyword intents give the same answers from the same numbers.

No QSwapie production, staging or preview systems are called. The only network calls are to the Anthropic API and Reson8.

## Built today vs existed before

- **Existed before**: QSwapie, the digital queue product for walk-in venues (guests scan a QR code, see their live place, wait anywhere, can trade places). Its code lives in a separate repository and was not changed or connected.
- **Built today, 2026-10-24**: everything in this repository. The host agent and its tools, barber voice mode (Reson8 proxy, voice tools, speech output), the offline fallbacks, the queue simulation and demo data, the web UI, and the pitch outlines.
- All guests are simulated with fake first names. No real people, no real venue data, no payments.
