// Barber voice page logic: mic -> /stt (Reson8) or Web Speech -> wake word "Hey Hazel" -> streamed reply spoken out loud.
// Expects $, esc, act and the global S (latest /api/state) from the page.
let muted = new URLSearchParams(location.search).get("voice") === "off", listening = false, speaking = false, thinking = false, sttMode = "", lastSpoken = null, lastCandidate = "";
let ws = null, audioCtx = null, micStream = null, proc = null, rec = null;

function vctl() {
  const icon = speaking ? "🔊" : thinking ? "✦" : listening ? "⏺" : "🎙";
  if ($("orbIcon")) $("orbIcon").textContent = icon;
  if ($("muteBtn")) $("muteBtn").textContent = muted ? "🔇 Voice off" : "🔊 Voice on";
  if ($("sttLabel")) $("sttLabel").textContent = sttMode ? "STT: " + sttMode : "";
  // State hooks for skins: orb on #voice-panel, mascot in the top bar.
  const orb = thinking ? "thinking" : speaking ? "speaking" : listening ? "listening" : "idle";
  if ($("voice-panel")) $("voice-panel").className = "is-" + orb;
  if ($("voiceCore")) $("voiceCore").className = "voice-core is-" + orb; // stage skin orb
  const mood = thinking || (S && S.agent.busy) ? "thinking" : speaking ? "happy" : "idle";
  $("mascot").className = "is-" + mood; $("mascot").dataset.state = mood;
  if (window.onVoiceState) window.onVoiceState(orb);
  if ($("micState")) $("micState").textContent = S && !S.dayStarted && !thinking ? "Say “Hey Hazel” to start the day." : thinking ? "Hazel is thinking…" : speaking ? "Hazel is talking (mic paused)" : listening ? "Listening… say “Hey Hazel”" : "Tap the mic once, then say “Hey Hazel”.";
}

function renderVoice() {
  if ($("closeAt") && document.activeElement !== $("closeAt")) $("closeAt").value = S.closeAt;
  const maxId = S.voice.length ? S.voice[S.voice.length - 1].id : 0;
  if (lastSpoken === null || maxId < lastSpoken) lastSpoken = maxId; // page load or reset: don't replay history
  for (const v of S.voice) if (v.id > lastSpoken) {
    lastSpoken = v.id;
    if (v.who !== "agent") continue;
    if (!v.proactive && streamedReplies > 0) { streamedReplies--; continue; }
    speak(v.text);
    awakeUntil = Date.now() + 9000; // proactive news: give the barber a moment to answer without the wake word
  }
  const html = S.voice.map(v => `<div class="vb ${v.who} transcript-item ${v.who === "barber" ? "barber" : "fade"}"><div class="meta speaker">${v.who === "barber" ? esc(S.barberName) : "<b>H</b> Hazel (AI)" + (v.proactive ? " · proactive" : "")} <time>${v.t}</time></div><p>${esc(v.text)}</p></div>`).join("");
  const log = $("voiceLog");
  if (log.dataset.h !== html) {
    log.innerHTML = html || `<p class="tok">Try: "Beautiful morning! Let's optimise today, open the queue."</p>`;
    log.dataset.h = html; log.scrollTop = log.scrollHeight;
  }
  vctl();
}

// Pick the most human voice available. Edge on Windows has neural "Natural" voices; Chrome has Google voices.
function voiceScore(v) {
  if (!v.lang || !v.lang.toLowerCase().startsWith("en")) return -1;
  let s = 0;
  if (/natural/i.test(v.name)) s += 100;
  if (/\b(Ava|Andrew|Emma|Brian|Jenny|Guy|Aria|Sonia|Ryan)\b/.test(v.name)) s += 20;
  if (/Google (US|UK) English/.test(v.name)) s += 50;
  if (/en-(US|GB)/i.test(v.lang)) s += 5;
  return s;
}
let voices = [];
function loadVoices() {
  voices = speechSynthesis.getVoices().filter(v => voiceScore(v) >= 0).sort((a, b) => voiceScore(b) - voiceScore(a));
  let saved = null; try { saved = localStorage.getItem("fadeVoice"); } catch {}
  const pick = voices.find(v => v.name === saved) || voices[0];
  $("voicePick").innerHTML = voices.map(v => `<option ${v === pick ? "selected" : ""}>${esc(v.name)}</option>`).join("") || "<option>default voice</option>";
}
function chosenVoice() { return voices.find(v => v.name === $("voicePick").value) || voices[0] || null; }
if (window.speechSynthesis) { loadVoices(); speechSynthesis.addEventListener("voiceschanged", loadVoices); }

function say(text) {
  if (muted || !window.speechSynthesis) return;
  const v = chosenVoice();
  // Sentence by sentence sounds less robotic than one long utterance.
  const parts = text.match(/[^.!?]+[.!?]*/g) || [text];
  for (const p of parts.map(x => x.trim()).filter(Boolean)) {
    const u = new SpeechSynthesisUtterance(p);
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "en-US";
    u.rate = 1.0; u.pitch = 1.0;
    u.onstart = () => {
      speaking = true; pauseRec(); vctl();
      // Safety net: some browsers never fire onend; never leave the mic paused for long.
      clearTimeout(say.guard);
      say.guard = setTimeout(() => { if (speaking) { speaking = false; resumeRec(); vctl(); } }, 2500 + p.split(" ").length * 450);
    };
    u.onend = u.onerror = () => setTimeout(() => {
      if (!speechSynthesis.speaking && !speechSynthesis.pending) { speaking = false; resumeRec(); }
      vctl();
    }, 100);
    speechSynthesis.speak(u);
  }
}
function speak(text) { say(text); }

const FILLERS = ["Hmm, let me check the chairs...", "One sec...", "Checking the book..."];
let streamedReplies = 0, awakeUntil = 0, holding = false;

// The clock pauses while the barber talks with Hazel, so the story doesn't run away mid-conversation.
function setHold(on) {
  if (on === holding) { if (on) act({ type: "hold", on: true, ms: 20000 }); return; }
  holding = on; act({ type: "hold", on, ms: 20000 });
}
setInterval(() => {
  const busy = thinking || speaking || Date.now() < awakeUntil;
  if (busy && holding) act({ type: "hold", on: true, ms: 20000 }); // refresh
  if (!busy && holding) setHold(false);
}, 4000);

// Wake word ("hey hazel", configurable with WAKE_WORDS); text after it is the command.
function findWake(text) {
  const norm = " " + text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim() + " ";
  const words = ((S && S.wakeWords) || ["hey hazel", "hazel", "hey q"]).slice().sort((x, y) => y.length - x.length);
  for (const w of words) {
    const i = norm.indexOf(" " + w + " ");
    if (i >= 0) return norm.slice(i + w.length + 2).trim();
  }
  return null;
}

async function handleUtterance(text, typed) {
  text = (text || "").trim();
  if (!text || thinking) return;
  const cmd = findWake(text);
  const awake = Date.now() < awakeUntil;
  if (cmd === null && !awake && !typed) { $("interim").textContent = `(heard "${text}": say "Hey Hazel" first)`; return; }
  setHold(true);
  if (S && !S.dayStarted) { // first wake: Hazel greets with today's outlook
    thinking = true; vctl();
    try { await act({ type: "startday" }); } finally { thinking = false; vctl(); }
    awakeUntil = Date.now() + 15000;
    return;
  }
  const command = cmd === null ? text : cmd;
  if (command.length < 2) { say(`Yes, ${S.barberName}?`); awakeUntil = Date.now() + 9000; return; }
  sendVoice(command);
}

// Streams the reply and speaks each sentence as soon as it is complete.
async function sendVoice(text) {
  text = (text || "").trim();
  if (!text || thinking) return;
  thinking = true; $("interim").textContent = text; vctl(); setHold(true);
  const t0 = performance.now();
  let firstSpoken = 0, buf = "";
  const speakReady = (final) => {
    const m = final ? [buf, buf] : buf.match(/^(.*?[.!?])(\s|$)/s);
    if (!m || !m[1].trim()) return;
    if (!firstSpoken) { firstSpoken = performance.now() - t0; if ($("latency")) $("latency").textContent = (firstSpoken / 1000).toFixed(1) + " s"; }
    say(m[1].trim()); buf = buf.slice(m[0].length);
    if (!final) speakReady(false);
  };
  const filler = setTimeout(() => { if (!firstSpoken) say(FILLERS[Math.floor(Math.random() * FILLERS.length)]); }, 1500);
  try {
    streamedReplies++;
    const r = await fetch("/api/voice-stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    const reader = r.body.getReader(), dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      speakReady(false);
    }
    speakReady(true);
  } catch { streamedReplies = Math.max(0, streamedReplies - 1); }
  finally { clearTimeout(filler); thinking = false; $("interim").textContent = ""; vctl(); awakeUntil = Date.now() + 9000; poll(); }
}

async function toggleMic() {
  if (listening) return stopMic();
  listening = true; vctl();
  try { speechSynthesis.speak(new SpeechSynthesisUtterance("")); } catch {} // unlock audio on this click
  if (S.reson8 && await startReson8()) return;
  if (startWebSpeech()) return;
  listening = false; sttMode = "typed only"; vctl();
  $("typed").focus();
}

function stopMic() {
  listening = false;
  const w = ws; ws = null; try { w && w.close(); } catch {}
  stopMicAudio();
  const r = rec; rec = null; try { r && r.abort(); } catch {}
  $("interim").textContent = ""; vctl();
}

function stopMicAudio() {
  try { proc && proc.disconnect(); audioCtx && audioCtx.close(); micStream && micStream.getTracks().forEach(t => t.stop()); } catch {}
  proc = audioCtx = micStream = null;
}

// Reson8 Turns via our server's /stt proxy: 16 kHz mono PCM16 up, turn events down.
async function startReson8() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  } catch { return false; }
  audioCtx = new AudioContext({ sampleRate: 16000 });
  const ratio = audioCtx.sampleRate / 16000;
  const sock = new WebSocket(`ws://${location.host}/stt`);
  sock.binaryType = "arraybuffer";
  const ok = await new Promise(res => { sock.onopen = () => res(true); sock.onclose = () => res(false); setTimeout(() => res(sock.readyState === 1), 4000); });
  if (!ok || !listening) { try { sock.close(); } catch {} stopMicAudio(); return false; }
  ws = sock;
  sttMode = "Reson8 live turns";
  sock.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === "turn_start" && !thinking) $("interim").textContent = "…";
    if (m.type === "turn_end_candidate") { lastCandidate = m.text; if (!thinking) $("interim").textContent = m.text; }
    if (m.type === "turn_end") { const t = lastCandidate; lastCandidate = ""; if (!speaking) handleUtterance(t); }
  };
  sock.onclose = () => { // Reson8 dropped: fall back to the browser recogniser
    if (ws !== sock || !listening) return;
    ws = null; stopMicAudio();
    if (!startWebSpeech()) { listening = false; sttMode = "typed only"; }
    vctl();
  };
  const src = audioCtx.createMediaStreamSource(micStream);
  proc = audioCtx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== 1) return;
    const f = e.inputBuffer.getChannelData(0);
    const n = Math.floor(f.length / ratio), out = new Int16Array(n);
    for (let i = 0; i < n; i++) { const x = speaking ? 0 : f[Math.floor(i * ratio)]; out[i] = Math.max(-1, Math.min(1, x)) * 0x7fff; }
    ws.send(out.buffer);
  };
  src.connect(proc); proc.connect(audioCtx.destination);
  vctl();
  return true;
}

// Fallback: Chrome's built-in speech recognition.
function startWebSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return false;
  rec = new SR(); rec.lang = "en-US"; rec.continuous = true; rec.interimResults = true;
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) handleUtterance(t); else if (!thinking) $("interim").textContent = t;
    }
  };
  rec.onend = () => { if (listening && rec && !speaking) try { rec.start(); } catch {} };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture") {
      const r = rec; rec = null; listening = false; sttMode = "typed only (no mic)"; try { r.abort(); } catch {}
      vctl(); $("typed").focus();
    }
  };
  try { rec.start(); } catch { return false; }
  sttMode = "browser speech";
  vctl();
  return true;
}
function pauseRec() { try { rec && rec.abort(); } catch {} }
function resumeRec() { if (listening && rec) try { rec.start(); } catch {} }

