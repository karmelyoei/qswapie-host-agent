# QSwapie Host Agent: submission outline

**OUTLINE ONLY, rewrite in your own words**

## Project name
- QSwapie Host Agent

## One-liner (pick one, or write your own)
- A proactive AI host that runs the waiting line for walk-in venues.
- The queue agent that tells guests when to come back, before they ask.
- [your own one-liner]

## Problem
- Walk-in waiting is dead time for guests.
- Guests walk away, owners lose business.
- Chairs sit idle when the next guest is not there.

## What it does
- Watches the live queue, predicts wait as an honest range.
- Messages guests: "come back in about 10 min", "you're next, head back now".
- Flags no-shows and moves the line up.
- "In a hurry" guest: finds a guest who will swap later, proposes it to both. No money.
- Alerts the owner: deep queue (pause new joins?), no-shows (call the next 2), end of day summary.
- Every action shows in the agent activity feed with a one line reason.
- Measured in the demo: idle chair minutes, no-shows handled, swaps done.

## How it uses Claude
- Model: claude-sonnet-5-5 with tool use.
- Tools: get_queue, predict_wait, message_guest, propose_swap, mark_no_show, alert_owner. Every action carries a reason.
- Proactive trigger loop: runs on a timer and on queue events, no user prompt needed.
- Compact state: send only a short queue snapshot, not the full history.
- Token budget: max 1200 output tokens per call, effort low, at most one Claude run per 5 seconds and only when something changed, hard cap 150 calls per run (counter on screen)
- Fallback: rule based offline mode if the API fails, so the demo never stops.

## Built today vs existed before
- Existed before: QSwapie digital queue (QR code, live place, trade places, Cloudflare Workers).
- Built today: the agent, the tool use loop, the UI, the simulation, the fallback.
- Data: simulated, fake first names. Not connected to the real queue yet.

## Tech stack
- Node 24 and TypeScript
- @anthropic-ai/sdk
- Plain HTML UI (queue, guest phone view, owner view and feed)
- Local only, no deploy

## Challenges
- [honest wait ranges instead of fake single numbers]
- [keeping the agent useful but not spammy]
- [making the demo reliable: fallback]
- [building it all in one day]

## What is next
- Connect to the real QSwapie queue.
- SMS and WhatsApp for real guests.
- Voice, maybe with partner tech.
- Pilot venues in Berlin.

## Demo instructions
- `npm start`
- Open http://localhost:5173
- Click "Simulate rush", use the speed control.
- Watch the activity feed on the right.
- Needs an Anthropic API key in env, otherwise it runs in offline fallback mode: ANTHROPIC_API_KEY (env or a local .env file)
