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

**With Claude** (PowerShell, from this folder; the key is typed hidden and only lives in that window):

```powershell
$env:ANTHROPIC_API_KEY = [Net.NetworkCredential]::new('', (Read-Host 'Anthropic key' -AsSecureString)).Password; npm start
```

Or put `ANTHROPIC_API_KEY=...` in a local `.env` file (gitignored, see `.env.example`).
Without a key, or if the API fails, the app keeps running in **Offline rules** mode (orange label at the top). It retries Claude after 60 seconds.

## 2-minute demo script

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

No QSwapie production, staging or preview systems are called. The only network call is to the Anthropic API.

## Built today vs existed before

- **Existed before**: QSwapie, the digital queue product for walk-in venues (guests scan a QR code, see their live place, wait anywhere, can trade places). Its code lives in a separate repository and was not changed or connected.
- **Built today, 2026-10-24**: everything in this repository. The host agent and its tools, the offline fallback, the queue simulation and demo data, the web UI, and the pitch outlines.
- All guests are simulated with fake first names. No real people, no real venue data, no payments.
