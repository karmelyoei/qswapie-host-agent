// Barber voice page logic: mic -> /stt (Reson8) or Web Speech -> POST voice -> Fade's reply spoken out loud.
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
  if ($("micState")) $("micState").textContent = S && !S.dayStarted && !thinking ? "Tap Start day, Fade will say hi." : thinking ? "Fade is thinking…" : speaking ? "Fade is talking (mic paused)" : listening ? "Listening… just talk." : "Tap the mic and talk. Fade answers out loud.";
}

function renderVoice() {
  if ($("closeAt") && document.activeElement !== $("closeAt")) $("closeAt").value = S.closeAt;
  const maxId = S.voice.length ? S.voice[S.voice.length - 1].id : 0;
  if (lastSpoken === null || maxId < lastSpoken) lastSpoken = maxId; // page load or reset: don't replay history
  for (const v of S.voice) if (v.id > lastSpoken) { lastSpoken = v.id; if (v.who === "agent") speak(v.text); }
  const html = S.voice.map(v => `<div class="vb ${v.who} transcript-item ${v.who === "barber" ? "barber" : "fade"}"><div class="meta speaker">${v.who === "barber" ? esc(S.barberName) : "<b>F</b> Fade (AI)" + (v.proactive ? " · proactive" : "")} <time>${v.t}</time></div><p>${esc(v.text)}</p></div>`).join("");
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

const FILLERS = ["Hmm, let me check the chairs...", "One sec, boss...", "Checking the book...", "Let me peek at the queue..."];
async function sendVoice(text) {
  text = (text || "").trim();
  if (!text || thinking) return;
  thinking = true; $("interim").textContent = text; vctl();
  const filler = setTimeout(() => say(FILLERS[Math.floor(Math.random() * FILLERS.length)]), 1500);
  try { await act({ type: "voice", text }); } finally { clearTimeout(filler); thinking = false; $("interim").textContent = ""; vctl(); }
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
    if (m.type === "turn_end") { const t = lastCandidate; lastCandidate = ""; if (!speaking) sendVoice(t); }
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
      if (e.results[i].isFinal) sendVoice(t); else if (!thinking) $("interim").textContent = t;
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

