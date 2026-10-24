# APIs and tools

Everything the project uses, with exact versions and values taken from the code.

## Runtime dependencies

| Package | Version | Use |
|---|---|---|
| `@anthropic-ai/sdk` | 1.3.0 (`^1.3.0` in `package.json`) | Messages API client |
| `ws` | 8.22.0 (`^8.22.0`) | WebSocket server for `/stt` and client for Reson8 |

`@types/ws` is the only dev dependency (types, not needed at runtime). There are no other runtime dependencies, no bundler, and no build step.

## Anthropic Messages API

- Client: `@anthropic-ai/sdk`, created as `new Anthropic({ maxRetries: 1, timeout: 30000 })`. The key is read from `ANTHROPIC_API_KEY` by the SDK.
- Model: `claude-sonnet-5-5`.
- Style: a manual tool-use loop (no SDK tool runner). The agent reads `tool_use` blocks, runs the tools itself, and sends `tool_result` blocks back.
- `output_config: { effort: "low" }` on every request (tick, voice, summary).
- Voice requests also set `thinking: { type: "between_tools" }` so spoken replies stay fast. If the API answers 400, the agent removes this setting once and retries without it.
- `max_tokens`: 1200 (guest-agent tick runs), 300 (voice turns), 400 (end-of-day summary).
- Loop limits: 2 requests per tick run, 4 per voice turn.
- `stop_reason` handling: `refusal` falls back to offline rules (tick) or the keyword voice rules (voice). In voice, `max_tokens` speaks the partial text.

### Guest agent tools (tick runs)

System prompt: the proactive host of the shop. It acts on its own, "doing nothing is fine", and every action tool needs a one-line `reason` that is shown in the activity feed.

| Tool | Input | What it does |
|---|---|---|
| `get_queue` | none | Returns the current compact queue JSON (`agentView()`). Read only. |
| `predict_wait` | `guest_id` (string, required) | Returns the guest's wait range in minutes, or "not waiting". Read only. |
| `message_guest` | `guest_id`, `kind` (`head_back_now`, `come_back_later`, `update`), `text`, `reason` (all required) | Sends a message to a guest's phone. The engine rejects a repeated `kind` for the same guest (except `update`). `head_back_now` marks an away guest as walking back. |
| `propose_swap` | `hurry_guest_id`, `partner_guest_id`, `reason` (all required) | Asks a guest ahead (who said swap is fine) to swap with the hurried guest. Both guests get a message. Engine checks that both are waiting and the partner is ahead. The swap resolves after 1.5 sim minutes. |
| `mark_no_show` | `guest_id`, `reason` (required) | Releases a called guest who did not arrive. The engine requires at least 3 minutes since the call. The next guest is called. |
| `alert_owner` | `text`, `suggested_action` (`pause_joins`, `resume_joins`, `add_staff`, `none`), `reason` (all required) | Shows an alert on the owner view with one action button. The engine drops duplicates (15 minute window). In barber voice mode, join-related actions are refused because the barber controls the queue by voice. |

### Voice tools (Hazel)

System prompt: Hazel, a cheeky and warm sidekick. One or two short spoken sentences (about 25 words), no lists, no markdown, times spoken the way people say them. Every number must come from a tool.

| Tool | Input | What it does |
|---|---|---|
| `day_summary` | none | Today's numbers: current time, queue open or closed, closing time, barbers, clients today, served, who is in the chair, waiting, cancelled, no-shows, average cut length, estimated finish. |
| `estimate_finish` | none | When the last client in line will be done at the current pace: finish time, closing time, number waiting. |
| `capacity_check` | `extra_clients` (integer, required) | Can the shop take N more clients before closing: finish time with extras, whether it fits, minutes over or under closing, spare slots, clients today. |
| `open_queue` | `reason` (string, optional) | Opens the queue for new walk-ins. In the barber scenario the first open starts the scripted day. |
| `close_queue` | `reason` (string, optional) | Closes the queue to new walk-ins. People already in line stay. |
| `recent_events` | none | What happened since the barber last asked: cancellations, swaps, no-shows, and a count of new joins. Marks those events as heard so they are not repeated between cuts. |

Voice context sent per turn: the last 4 transcript lines (rebuilt as alternating user and assistant messages), with a prefix on the latest barber line giving the time, queue state, and closing time.

### Offline equivalents

When Claude is unavailable, `rules()` applies the same goals to the guest agent with template messages, and `voiceRules()` maps keywords (open, close, capacity, "what's new", "how's today") to the same voice tools and canned answers.

## Reson8 Turns (speech to text)

| Item | Value |
|---|---|
| Endpoint | `wss://api.reson8.dev/v1/speech-to-text/turns` |
| Auth | HTTP header `Authorization: ApiKey <key>` where `<key>` is the value of `RESON8_API_KEY` (placeholder here, never written in code or logs) |
| Query parameters | `encoding=pcm_s16le`, `sample_rate=16000`, `channels=1`, `language=en` |
| Audio | Raw PCM, signed 16 bit little endian, 16 kHz, mono, sent as binary WebSocket frames (4096 sample chunks from a `ScriptProcessor` node) |
| Events used | `turn_start` (show a placeholder), `turn_end_candidate` with `text` (interim line, remembered), `turn_end` (send the remembered text to the agent) |
| Other frames | A text frame from the browser (for example `flush_request`) is passed through to Reson8 |
| Connection | One upstream socket per browser socket. The browser reaches it only through our `/stt` proxy. The server adds the header, so the key never reaches the browser |

Close codes sent by our proxy to the browser:

| Code | Meaning | Browser reaction |
|---|---|---|
| 4001 | No `RESON8_API_KEY` set on the server | Use the browser recogniser |
| 4002 | Reson8 problem: HTTP error status on connect (`Reson8 HTTP <status>`), socket error, or upstream close (`Reson8 closed <code>`) | Use the browser recogniser |

The page also falls back if the proxy socket does not open within 4 seconds or the microphone cannot be opened.

## Web Speech API (browser)

- `SpeechRecognition` (or `webkitSpeechRecognition`) is the fallback speech-to-text: `lang = en-US`, `continuous = true`, `interimResults = true`. Final results are sent to the agent, interim results show as the live line. It restarts on `onend` while listening and is aborted while Hazel speaks. Errors `not-allowed`, `service-not-allowed`, and `audio-capture` switch the page to typed input.
- `speechSynthesis` speaks Hazel's replies. English voices are scored, and voices with "Natural" in the name (the neural voices in Microsoft Edge on Windows) rank first, then Google US and UK English voices and a short list of known good names. The choice can be changed in a dropdown and is remembered in `localStorage`. Text is split into sentences and each sentence is spoken as its own utterance. The microphone is paused while speaking, with a timer guard in case a browser never fires `onend`.

## Node 24 built-ins

| Built-in | Use |
|---|---|
| `node:http` | The HTTP server (JSON API and static files) |
| `node:fs` | Reads files from `public/` |
| `node:path` | Safe static file paths, `import.meta.dirname` |
| `process.loadEnvFile(".env")` | Loads the optional gitignored `.env` file (missing file is fine) |
| Type stripping | `node src/server.ts` runs TypeScript directly. Source files use `.ts` import specifiers. |
| `fetch`, `WebSocket` (browser) | Used by the pages only |

`npm start` runs `node src/server.ts`. Node 24 or newer is required.

## Our own HTTP API

The server listens on `127.0.0.1:PORT` (default 5173). Static files come from `public/`; the query string is ignored for routing (for example `?voice=off`).

### GET /api/state

Returns one JSON snapshot used by both pages (polled about twice a second):

- `now`, `speed`, `running`, `staff`, `joinsPaused`, `dayClosed`, `summary`, `scenario`, `voiceMode`, `dayStarted`, `barberName`, `closeAt`
- `voice`: the voice transcript lines (`id`, `t`, `who`, `text`, `proactive`)
- `reson8`: boolean, whether a Reson8 key is configured (the key itself is never sent)
- `stats`: served, in chair, waiting, no-shows, swaps, agent messages, average wait, idle chair minutes, backlog
- `agent`: mode (`AI` or `offline`), offline reason, busy flag, calls, call cap, token counters, model
- `line`, `guests` (without hidden fields), `activity` (latest 60 entries), `alerts` (latest 8)

### POST /api/action

JSON body `{ "type": ..., ... }`. Response is `{}`.

| `type` | Fields | Effect |
|---|---|---|
| `rush` | none | Schedules nine walk-ins over a few sim minutes (demo button) |
| `speed` | `value` | Sim speed in sim minutes per real second, clamped to 0.25 to 8 |
| `pause` | none | Toggles pause and resume |
| `staff` | `delta` (positive or negative) | Adds or removes a barber, clamped to 1 to 4 |
| `joins` | none | Toggles whether new joins are paused (owner control) |
| `join` | none | Adds one walk-in |
| `hurry` | `id` | Guest taps "I'm in a hurry" |
| `swapok` | `id` | Guest says they are happy to swap to a later place |
| `alert` | `id`, `apply` (boolean) | Owner applies or dismisses an alert |
| `close` | none | Closes the day and writes the end-of-day summary (Claude or stats line) |
| `reset` | `scenario` (`"barber"` or anything else for the demo) | Creates a fresh simulation and a fresh agent (resets counters) |
| `startday` | none | Starts the clock on the barber day and makes Hazel greet the barber proactively |
| `closetime` | `value` as `HH:MM` | Sets the shop's closing time |
| `voice` | `text` (trimmed, at most 500 characters) | Runs the voice agent on the barber's text and appends both lines to the transcript |

The `/barber` page controls map onto these actions (Start day is `startday`); mute and the voice picker are browser-only. Static files: `/` and `/guests` serve `index.html` (stage skin CSS loaded unless `?skin=old`), `/barber` serves `skin/barber.html` (the stage skin) or `barber.html` with `?skin=old`, plus `voice.js` and `/skin/*`.

### WebSocket /stt

Browser to server: binary frames of 16 kHz mono PCM s16le (and optional text control frames). Server to browser: Reson8 text events as JSON. Closed with 4001 or 4002 as described above. See [ARCHITECTURE.md](ARCHITECTURE.md) for the sequence diagram.

## Update: morning shift and voice speed (latest)

- Voice replies use `claude-haiku-5-5` with `thinking: {type: "disabled"}` (dropped automatically if the API refuses it), `output_config.effort: "low"`, `max_tokens: 150`, streamed with `client.messages.stream()`. A compact `[state]` block (day summary, a two-extra capacity check, the last 3 notable events) goes into the prompt, so most turns need no tool call. The queue agent stays on `claude-sonnet-5-5`.
- `POST /api/voice-stream` `{text}`: streams Hazel's reply as `text/plain`; the browser speaks each sentence as soon as it is complete and shows the time to the first spoken word.
- `POST /api/action` `{type: "hold", on, ms}`: pauses the simulation clock while the barber talks with Hazel (max 30 s per refresh).
- Wake words: `WAKE_WORDS` env (comma-separated), exposed in `/api/state` as `wakeWords`; detection runs on the final transcript from Reson8 or the Web Speech API.
- The greeting and the go-ahead confirmation are templates filled from the simulation (instant, deterministic); every other voice turn goes to Haiku.
