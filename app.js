let micCtx = null;
let analyser = null;
let stream = null;
let rafId = null;

// --- Notes / helpers ---
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const A4 = 440;

// Accuracy thresholds (cents)
const IN_TUNE_CENTS = 5;
const CLOSE_CENTS   = 15;

// Spectrogram parameters
const MAX_HZ = 4000;
const LABEL_W = 190; // piano sidebar cap

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function centsBetween(freq, target) { return 1200 * Math.log2(freq / target); }
function absCents(note) { return Math.abs(note?.cents ?? 999); }

function qualityClassFromCents(cents) {
  const a = Math.abs(cents);
  if (a <= IN_TUNE_CENTS) return "good";
  if (a <= CLOSE_CENTS) return "close";
  return "bad";
}

function qualityClass(note) {
  return qualityClassFromCents(absCents(note));
}

function midiToFreq(m, a4 = A4) {
  return a4 * Math.pow(2, (m - 69) / 12);
}

function midiToName(m) {
  const name = NOTE_NAMES[((m % 12) + 12) % 12];
  const octave = Math.floor(m / 12) - 1;
  return `${name}${octave}`;
}

function midiToNameParts(m) {
  const pc = ((m % 12) + 12) % 12;
  const name = NOTE_NAMES[pc];
  const octave = Math.floor(m / 12) - 1;
  return { pc, name, octave };
}

function isBlackPc(pc) {
  return [1,3,6,8,10].includes(pc);
}

function freqToETNote(freq, a4 = A4) {
  if (!isFinite(freq) || freq <= 0) return null;
  const midi = 69 + 12 * Math.log2(freq / a4);
  const nearest = Math.round(midi);
  const cents = (midi - nearest) * 100;
  return { name: midiToName(nearest), cents, midi: nearest };
}

/* -----------------------------
   Detected pitches UI
------------------------------ */

function renderPitchCards(picks) {
  const list = document.getElementById("pitchlist");
  if (!list) return;

  if (!picks || picks.length === 0) {
    list.innerHTML = `<div class="empty">Click <b>Begin</b> and sing/play a chord.</div>`;
    return;
  }

  list.innerHTML = picks.map((p) => {
    const cents = p.note.cents;
    const cls = qualityClass(p.note);
    const pos = clamp(((cents + 50) / 100) * 100, 0, 100);
    const centsText = `${cents >= 0 ? "+" : ""}${cents.toFixed(0)}`;

    return `
      <div class="pitch ${cls}">
        <div>
          <div class="note">${p.note.name}</div>
          <div class="meta">${p.freq.toFixed(1)} Hz</div>
        </div>

        <div class="meter">
          <div class="fill ${cls}" style="left: calc(${pos}% - 7px)"></div>
        </div>

        <div class="cents">${centsText} <small>c</small></div>
      </div>
    `;
  }).join("");
}

/* -----------------------------
   Polyphonic-ish pitch picking
------------------------------ */

function harmonicScore(mag, binHz, f0, nHarm = 8, maxHz = 5000) {
  let score = 0;
  for (let h = 1; h <= nHarm; h++) {
    const fh = f0 * h;
    if (fh > maxHz) break;
    const idx = Math.round(fh / binHz);
    if (idx >= 0 && idx < mag.length) score += mag[idx] / h;
  }
  return score;
}

function multiPitchFromSpectrum(mag, sampleRate, fftSize, k = 3, fmin = 60, fmax = 1200) {
  const binHz = sampleRate / fftSize;

  const candN = 700;
  const cand = new Float32Array(candN);
  const scores = new Float32Array(candN);

  const logMin = Math.log(fmin);
  const logMax = Math.log(fmax);

  for (let i = 0; i < candN; i++) {
    const f0 = Math.exp(logMin + (logMax - logMin) * (i / (candN - 1)));
    cand[i] = f0;
    scores[i] = harmonicScore(mag, binHz, f0, 8, 5000);
  }

  const order = [...scores.keys()].sort((a, b) => scores[b] - scores[a]);

  const picked = [];
  for (const idx of order) {
    const f0 = cand[idx];

    let ok = true;
    for (const p of picked) {
      const semitones = Math.abs(Math.log2(f0 / p) * 12);
      if (semitones < 1.0) { ok = false; break; }
    }

    if (ok) picked.push(f0);
    if (picked.length >= k) break;
  }

  return picked.map(f => ({ freq: f, note: freqToETNote(f) })).filter(x => x.note);
}

/* -----------------------------
   Crisp canvas sizing
------------------------------ */

function sizeCanvasToDisplay(canvas, ctx) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(2, Math.round(rect.width * dpr));
  const h = Math.max(2, Math.round(rect.height * dpr));

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    ctx.imageSmoothingEnabled = false;
  }
  return { w, h, dpr };
}

/* -----------------------------
   Spectrogram internals
------------------------------ */

let specX = 0;
let specImg = null;
let rowToBin = null;
let rowToBinKey = "";

function buildRowToBin(h, maxHz, binHz, maxBin) {
  const key = `${h}|${maxHz}|${binHz}|${maxBin}`;
  if (rowToBin && rowToBinKey === key) return rowToBin;

  const f0 = 20;
  const arr = new Int32Array(h);

  for (let y = 0; y < h; y++) {
    const t = 1 - (y / (h - 1));
    const freq = f0 * Math.pow(maxHz / f0, t);
    const bin = Math.min(maxBin - 1, Math.max(0, Math.round(freq / binHz)));
    arr[y] = bin;
  }

  rowToBin = arr;
  rowToBinKey = key;
  return arr;
}

function yForFreq(freq, maxHz, h) {
  const f0 = 20;
  if (freq <= f0) return h - 1;
  if (freq >= maxHz) return 0;
  const t = Math.log(freq / f0) / Math.log(maxHz / f0);
  return (1 - t) * (h - 1);
}

function estimateLoudness01(lin, freq, sampleRate, fftSize, maxHz) {
  const binHz = sampleRate / fftSize;
  const maxBin = Math.min(lin.length, Math.floor(maxHz / binHz));
  const center = Math.round(freq / binHz);

  let sum = 0, count = 0;
  for (let d = -2; d <= 2; d++) {
    const i = center + d;
    if (i >= 0 && i < maxBin) { sum += lin[i]; count++; }
  }
  const avg = count ? (sum / count) : 0;

  const loud = Math.log10(1 + avg * 5000);
  return clamp(loud / 3.2, 0, 1);
}

/* -------- Piano sidebar -------- */

function midiKeyBoundsY(m, maxHz, h) {
  const f = midiToFreq(m);
  const fPrev = midiToFreq(m - 1);
  const fNext = midiToFreq(m + 1);

  const fLo = Math.sqrt(f * fPrev);
  const fHi = Math.sqrt(f * fNext);

  const yTop = yForFreq(fHi, maxHz, h);
  const yBot = yForFreq(fLo, maxHz, h);

  return { yTop: Math.min(yTop, yBot), yBot: Math.max(yTop, yBot) };
}

function drawPianoSidebar(ctx, maxHz, w, h, pianoW) {
  const minHz = 40;
  const minMidi = Math.max(0, Math.floor(69 + 12 * Math.log2(minHz / A4)));
  const maxMidi = Math.min(127, Math.ceil(69 + 12 * Math.log2(maxHz / A4)));

  ctx.save();

  ctx.fillStyle = "rgba(0,0,0,0.92)";
  ctx.fillRect(0, 0, pianoW, h);

  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.fillRect(pianoW - 1, 0, 1, h);

  // White keys
  for (let m = minMidi; m <= maxMidi; m++) {
    const { pc } = midiToNameParts(m);
    if (isBlackPc(pc)) continue;

    const { yTop, yBot } = midiKeyBoundsY(m, maxHz, h);
    const keyH = Math.max(1, yBot - yTop);

    const alt = (pc === 0 || pc === 5) ? 0.09 : 0.05;
    ctx.fillStyle = `rgba(255,255,255,${alt})`;
    ctx.fillRect(0, yTop, pianoW, keyH);

    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(yBot) + 0.5);
    ctx.lineTo(pianoW, Math.round(yBot) + 0.5);
    ctx.stroke();
  }

  // Black keys
  const blackInset = Math.round(pianoW * 0.48);
  const blackW = Math.max(18, pianoW - blackInset - 6);

  for (let m = minMidi; m <= maxMidi; m++) {
    const { pc } = midiToNameParts(m);
    if (!isBlackPc(pc)) continue;

    const { yTop, yBot } = midiKeyBoundsY(m, maxHz, h);
    const keyH = Math.max(1, yBot - yTop);

    ctx.fillStyle = "rgba(0,0,0,0.78)";
    ctx.fillRect(blackInset, yTop, blackW, keyH);

    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;
    ctx.strokeRect(blackInset + 0.5, yTop + 0.5, blackW - 1, keyH - 1);
  }

  // Yellow labels (naturals only; C shows octave)
  ctx.textBaseline = "middle";

  for (let m = minMidi; m <= maxMidi; m++) {
    const { pc, octave, name } = midiToNameParts(m);
    if (isBlackPc(pc)) continue;

    const f = midiToFreq(m);
    if (f < 20 || f > maxHz) continue;

    const y = yForFreq(f, maxHz, h);
    const ly = clamp(y, 12, h - 12);

    const isC = pc === 0;
    const label = isC ? `C${octave}` : name;

    ctx.font = isC
      ? "900 20px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial"
      : "800 12px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";

    ctx.fillStyle = "rgba(255, 221, 80, 0.98)";
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.lineWidth = isC ? 4 : 3;

    const lx = 10;
    ctx.strokeText(label, lx, ly);
    ctx.fillText(label, lx, ly);
  }

  ctx.restore();
}

function drawPitchDots(ctx, picks, x, maxHz, h, lin, sampleRate, fftSize) {
  if (!picks || picks.length === 0) return;

  for (const p of picks) {
    const y = yForFreq(p.freq, maxHz, h);

    const loud01 = estimateLoudness01(lin, p.freq, sampleRate, fftSize, maxHz);
    const a = 0.35 + 0.65 * loud01;
    const g = 0.15 + 0.55 * loud01;

    const cents = Math.abs(p.note.cents);
    let color;
    if (cents <= IN_TUNE_CENTS)      color = { r: 90,  g: 230, b: 170 };
    else if (cents <= CLOSE_CENTS)   color = { r: 245, g: 225, b: 90  };
    else                             color = { r: 255, g: 110, b: 110 };

    ctx.beginPath();
    ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${a.toFixed(3)})`;
    ctx.arc(x, y, 10.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.min(1, g + 0.25).toFixed(3)})`;
    ctx.lineWidth = 4.5;
    ctx.arc(x, y, 15.5, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.max(0.12, g * 0.55).toFixed(3)})`;
    ctx.lineWidth = 9;
    ctx.arc(x, y, 22, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawSpectrogramColumn(ctx, lin, sampleRate, fftSize, canvas, picks, maxHz = MAX_HZ) {
  const { w, h } = sizeCanvasToDisplay(canvas, ctx);

  const pianoW = Math.min(LABEL_W, Math.max(120, Math.floor(w * 0.16)));
  const plotX0 = pianoW;
  const plotW = Math.max(40, w - plotX0);

  if (!specImg || specImg.width !== w || specImg.height !== h) {
    specImg = ctx.createImageData(w, h);
    for (let i = 0; i < specImg.data.length; i += 4) {
      specImg.data[i + 0] = 0;
      specImg.data[i + 1] = 0;
      specImg.data[i + 2] = 0;
      specImg.data[i + 3] = 255;
    }
    specX = 0;
  }

  const binHz = sampleRate / fftSize;
  const maxBin = Math.min(lin.length, Math.floor(maxHz / binHz));
  const map = buildRowToBin(h, maxHz, binHz, maxBin);

  // percentile normalization
  const sampleN = 256;
  const step = Math.max(1, Math.floor(maxBin / sampleN));
  const samples = [];
  for (let i = 0; i < maxBin; i += step) samples.push(lin[i]);
  samples.sort((a,b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)] || 1e-9;
  const normDen = Math.max(p95, 1e-9);

  const x = plotX0 + specX;

  for (let y = 0; y < h; y++) {
    const bin = map[y];
    const norm = lin[bin] / normDen;
    const clipped = Math.min(1.0, norm);
    const boosted = Math.pow(clipped, 0.25);
    const intensity = Math.max(0, Math.min(255, Math.round(boosted * 255)));

    const r = 0;
    const g = Math.round(intensity * 0.55);
    const b = intensity;

    const idx = (y * w + x) * 4;
    specImg.data[idx + 0] = r;
    specImg.data[idx + 1] = g;
    specImg.data[idx + 2] = b;
    specImg.data[idx + 3] = 255;
  }

  ctx.putImageData(specImg, 0, 0);
  drawPianoSidebar(ctx, maxHz, w, h, plotX0);

  ctx.fillStyle = "rgba(90,185,255,0.20)";
  ctx.fillRect(x, 0, 1, h);

  drawPitchDots(ctx, picks, x, maxHz, h, lin, sampleRate, fftSize);

  specX = (specX + 1) % plotW;
}

/* -----------------------------
   Intonation practice
------------------------------ */

const RATIOS = {
  just: [1/1,16/15,9/8,6/5,5/4,4/3,45/32,3/2,8/5,5/3,9/5,15/8],
  pyth: [1/1,256/243,9/8,32/27,81/64,4/3,729/512,3/2,128/81,27/16,16/9,243/128]
};

function targetFreqForInterval(tonicFreq, semitones, system) {
  const oct = Math.floor(semitones / 12);
  const step = ((semitones % 12) + 12) % 12;

  if (system === "equal") return tonicFreq * Math.pow(2, semitones / 12);

  const ratio = RATIOS[system]?.[step] ?? 1;
  return tonicFreq * ratio * Math.pow(2, oct);
}

const INTERVALS = [
  { semis: 1,  short: "m2", name: "Minor 2nd" },
  { semis: 2,  short: "M2", name: "Major 2nd" },
  { semis: 3,  short: "m3", name: "Minor 3rd" },
  { semis: 4,  short: "M3", name: "Major 3rd" },
  { semis: 5,  short: "P4", name: "Perfect 4th" },
  { semis: 6,  short: "TT", name: "Tritone" },
  { semis: 7,  short: "P5", name: "Perfect 5th" },
  { semis: 8,  short: "m6", name: "Minor 6th" },
  { semis: 9,  short: "M6", name: "Major 6th" },
  { semis: 10, short: "m7", name: "Minor 7th" },
  { semis: 11, short: "M7", name: "Major 7th" },
  { semis: 12, short: "P8", name: "Octave" }
];

let practiceSystem = "equal";
let practiceWave = "sine";      // <-- ONE waveform for both tonic + chord
let practiceRefMidi = null;
let practiceIntervals = [];     // multi-select, max 4

let practiceCtx = null;
let practiceGain = null;
let practiceRefOsc = null;
let practiceTargetOscs = [];

function buildMidiRangeC3toC5() {
  const out = [];
  for (let m = 48; m <= 72; m++) out.push(m);
  return out;
}

async function ensurePracticeAudio() {
  if (!practiceCtx) practiceCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (practiceCtx.state === "suspended") {
    try { await practiceCtx.resume(); } catch {}
  }
  if (!practiceGain) {
    practiceGain = practiceCtx.createGain();
    practiceGain.gain.value = parseFloat(document.getElementById("practiceVol")?.value ?? "0.18");
    practiceGain.connect(practiceCtx.destination);
  }
}

function stopOsc(osc) {
  if (!osc) return null;
  try { osc.stop(); } catch {}
  try { osc.disconnect(); } catch {}
  return null;
}

function stopPracticeOsc(which="both") {
  if (which === "ref" || which === "both") practiceRefOsc = stopOsc(practiceRefOsc);
  if (which === "target" || which === "both") {
    for (const o of practiceTargetOscs) stopOsc(o);
    practiceTargetOscs = [];
  }
}

async function startPracticeRef() {
  const playRef = !!document.getElementById("practicePlayRef")?.checked;
  if (!playRef || practiceRefMidi == null) { stopPracticeOsc("ref"); return; }

  await ensurePracticeAudio();
  stopPracticeOsc("ref");

  const f = midiToFreq(practiceRefMidi, A4);
  practiceRefOsc = practiceCtx.createOscillator();
  practiceRefOsc.type = practiceWave || "sine";
  practiceRefOsc.frequency.value = f;
  practiceRefOsc.connect(practiceGain);
  practiceRefOsc.start();
}

function practiceTargetsInfo() {
  if (practiceRefMidi == null || practiceIntervals.length === 0) return [];
  const tonic = midiToFreq(practiceRefMidi, A4);

  return practiceIntervals.map(iv => {
    const tf = targetFreqForInterval(tonic, iv.semis, practiceSystem);
    const tn = freqToETNote(tf);
    return { interval: iv, freq: tf, note: tn?.name ?? "—" };
  });
}

async function startPracticeTargetsChord() {
  const playTarget = !!document.getElementById("practicePlayTarget")?.checked;

  if (!playTarget || practiceRefMidi == null || practiceIntervals.length === 0) {
    stopPracticeOsc("target");
    return;
  }

  await ensurePracticeAudio();
  stopPracticeOsc("target");

  const targets = practiceTargetsInfo();
  for (const t of targets) {
    const osc = practiceCtx.createOscillator();
    osc.type = practiceWave || "sine";
    osc.frequency.value = t.freq;
    osc.connect(practiceGain);
    osc.start();
    practiceTargetOscs.push(osc);
  }
}

function setPracticeActiveButtons() {
  document.querySelectorAll(".pRef.active").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".intbtn.active").forEach(b => b.classList.remove("active"));

  if (practiceRefMidi != null) {
    document.querySelector(`.pRef[data-midi="${practiceRefMidi}"]`)?.classList.add("active");
  }
  for (const it of practiceIntervals) {
    document.querySelector(`.intbtn[data-semis="${it.semis}"]`)?.classList.add("active");
  }
}

function renderPracticeTargetsList(rows) {
  const box = document.getElementById("practiceTargetsList");
  if (!box) return;

  if (!rows || rows.length === 0) {
    box.innerHTML = "";
    return;
  }

  box.innerHTML = rows.map(r => {
    const centsText = (r.cents == null || !isFinite(r.cents))
      ? "—"
      : `${r.cents >= 0 ? "+" : ""}${r.cents.toFixed(0)}c`;

    const cls = r.cls || "";

    return `
      <div class="targetrow ${cls}">
        <div class="tname">
          ${r.intervalName}
          <span class="tmeta">(${r.note} · ${r.freq.toFixed(1)} Hz)</span>
          <div class="tdet">Detected: ${r.detectedText ?? "—"}</div>
        </div>
        <div class="tcents">${centsText}</div>
      </div>
    `;
  }).join("");
}

function setPracticeReadoutIdle() {
  const t = document.getElementById("practiceTonic");
  const i = document.getElementById("practiceInterval");
  const s = document.getElementById("practiceStatus");
  const c = document.getElementById("practiceCents");
  const d = document.getElementById("practiceDetected");
  const tg = document.getElementById("practiceTarget");

  if (t) t.textContent = practiceRefMidi == null ? "—" : midiToName(practiceRefMidi);
  if (i) i.textContent = practiceIntervals.length ? practiceIntervals.map(x => x.short).join(" · ") : "—";

  if (tg) tg.textContent = "—";
  if (d) d.textContent = "—";
  if (s) { s.textContent = "Select a tonic + intervals"; s.className = "refstatus"; }
  if (c) c.textContent = "";
}

function buildPracticeUI() {
  const refGrid = document.getElementById("practiceRefGrid");
  const intGrid = document.getElementById("practiceIntGrid");
  if (!refGrid || !intGrid) return;

  // tonic grid
  const midis = buildMidiRangeC3toC5();
  refGrid.innerHTML = midis
    .map(m => `<button type="button" class="notebtn pRef" data-midi="${m}">${midiToName(m)}</button>`)
    .join("");

  // interval grid
  intGrid.innerHTML = INTERVALS
    .map(x => `<button type="button" class="intbtn" data-semis="${x.semis}">${x.short}</button>`)
    .join("");

  // tonic click (toggle)
  refGrid.addEventListener("click", async (e) => {
    const btn = e.target.closest(".pRef");
    if (!btn) return;

    const midi = parseInt(btn.dataset.midi, 10);

    // toggle off
    if (practiceRefMidi === midi) {
      practiceRefMidi = null;
      practiceIntervals = [];
      stopPracticeOsc("both");
      setPracticeActiveButtons();
      renderPracticeTargetsList([]);
      setPracticeReadoutIdle();
      return;
    }

    practiceRefMidi = midi;
    setPracticeActiveButtons();

    await startPracticeRef();
    await startPracticeTargetsChord();

    // render tiles (no feedback yet)
    const targets = practiceTargetsInfo();
    renderPracticeTargetsList(targets.map(t => ({
      intervalName: t.interval.name,
      note: t.note,
      freq: t.freq,
      cents: null,
      cls: "",
      detectedText: "—"
    })));

    // header readout is now just setup state (no "closest target")
    const s = document.getElementById("practiceStatus");
    const c = document.getElementById("practiceCents");
    if (s) { s.textContent = practiceIntervals.length ? "Sing your selected targets" : "Select intervals"; s.className = "refstatus"; }
    if (c) c.textContent = "";
    const tEl = document.getElementById("practiceTonic");
    if (tEl) tEl.textContent = midiToName(practiceRefMidi);
  });

  // interval click (multi-select up to 4)
  intGrid.addEventListener("click", async (e) => {
    const btn = e.target.closest(".intbtn");
    if (!btn) return;

    const semis = parseInt(btn.dataset.semis, 10);
    const iv = INTERVALS.find(x => x.semis === semis);
    if (!iv) return;

    const idx = practiceIntervals.findIndex(x => x.semis === semis);
    if (idx !== -1) {
      practiceIntervals.splice(idx, 1);
    } else {
      if (practiceIntervals.length >= 4) practiceIntervals.shift();
      practiceIntervals.push(iv);
    }

    setPracticeActiveButtons();
    await startPracticeTargetsChord();

    const targets = practiceTargetsInfo();
    renderPracticeTargetsList(targets.map(t => ({
      intervalName: t.interval.name,
      note: t.note,
      freq: t.freq,
      cents: null,
      cls: "",
      detectedText: "—"
    })));

    const s = document.getElementById("practiceStatus");
    const c = document.getElementById("practiceCents");
    if (s) { s.textContent = (practiceRefMidi && practiceIntervals.length) ? "Sing your selected targets" : "Select a tonic + intervals"; s.className = "refstatus"; }
    if (c) c.textContent = "";

    const iEl = document.getElementById("practiceInterval");
    if (iEl) iEl.textContent = practiceIntervals.length ? practiceIntervals.map(x => x.short).join(" · ") : "—";
  });

  // tuning system changes
  const sys = document.getElementById("practiceSystem");
  if (sys) {
    practiceSystem = sys.value || "equal";
    sys.addEventListener("change", async () => {
      practiceSystem = sys.value || "equal";
      await startPracticeTargetsChord();

      const targets = practiceTargetsInfo();
      renderPracticeTargetsList(targets.map(t => ({
        intervalName: t.interval.name,
        note: t.note,
        freq: t.freq,
        cents: null,
        cls: "",
        detectedText: "—"
      })));
    });
  }

  // ONE waveform dropdown that affects everything (tonic + chord)
  const wave = document.getElementById("practiceWave");
  if (wave) {
    practiceWave = wave.value || "sine";
    wave.addEventListener("change", async () => {
      practiceWave = wave.value || "sine";
      await startPracticeRef();
      await startPracticeTargetsChord();
    });
  }

  document.getElementById("practicePlayRef")?.addEventListener("change", () => startPracticeRef());
  document.getElementById("practicePlayTarget")?.addEventListener("change", () => startPracticeTargetsChord());

  document.getElementById("practiceVol")?.addEventListener("input", async (e) => {
    await ensurePracticeAudio();
    if (practiceGain) practiceGain.gain.value = parseFloat(e.target.value);
  });

  document.getElementById("practiceStop")?.addEventListener("click", () => {
    stopPracticeOsc("both");
    practiceRefMidi = null;
    practiceIntervals = [];
    setPracticeActiveButtons();
    renderPracticeTargetsList([]);
    setPracticeReadoutIdle();
  });

  setPracticeReadoutIdle();
}

/* -----------------------------
   Mic handling
------------------------------ */

async function startMic() {
  const startBtn = document.getElementById("start");
  const stopBtn  = document.getElementById("stop");
  const status   = document.getElementById("status");
  const out      = document.getElementById("out");
  const canvas   = document.getElementById("spec");
  const ctx      = canvas.getContext("2d", { alpha: false });

  status.textContent = "Requesting mic permission…";
  stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  micCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = micCtx.createMediaStreamSource(stream);

  analyser = micCtx.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0.55;
  src.connect(analyser);

  const bins = analyser.frequencyBinCount;
  const db = new Float32Array(bins);
  const lin = new Float32Array(bins);

  startBtn.disabled = true;
  stopBtn.disabled = false;

  status.textContent = "Listening…";
  document.getElementById("dot")?.classList.add("live");

  function loop() {
    analyser.getFloatFrequencyData(db);

    for (let i = 0; i < bins; i++) {
      const v = db[i];
      lin[i] = (v === -Infinity) ? 0 : Math.pow(10, v / 20);
    }

    let max = 0;
    for (let i = 0; i < bins; i++) if (lin[i] > max) max = lin[i];

    let picks = [];

    if (max < 1e-4) {
      out.textContent = "—";
      renderPitchCards([]);

      // if practice is armed, keep tiles but clear live cents
      if (practiceRefMidi != null && practiceIntervals.length > 0) {
        const targets = practiceTargetsInfo();
        renderPracticeTargetsList(targets.map(t => ({
          intervalName: t.interval.name,
          note: t.note,
          freq: t.freq,
          cents: null,
          cls: "",
          detectedText: "—"
        })));
      }
    } else {
      picks = multiPitchFromSpectrum(lin, micCtx.sampleRate, analyser.fftSize, 3);

      out.textContent = picks.length
        ? picks.map(p => `${p.note.name}  ${p.freq.toFixed(1)} Hz  (${p.note.cents.toFixed(0)} cents)`).join("\n")
        : "—";

      renderPitchCards(picks);

      // --- Practice feedback for EACH selected target (no "closest target") ---
      if (practiceRefMidi != null && practiceIntervals.length > 0) {
        const targets = practiceTargetsInfo();

        const rows = targets.map(t => {
          let bestCents = null;
          let bestAbs = Infinity;
          let bestDetected = null;

          for (const p of picks) {
            const c = centsBetween(p.freq, t.freq);
            const a = Math.abs(c);
            if (a < bestAbs) {
              bestAbs = a;
              bestCents = c;
              bestDetected = p;
            }
          }

          const cls = (bestCents == null) ? "" : qualityClassFromCents(bestCents);

          return {
            intervalName: t.interval.name,
            note: t.note,
            freq: t.freq,
            cents: bestCents,
            cls,
            detectedText: bestDetected ? `${bestDetected.note.name} (${bestDetected.freq.toFixed(1)} Hz)` : "—"
          };
        });

        renderPracticeTargetsList(rows);

        // Keep header simple
        const s = document.getElementById("practiceStatus");
        const c = document.getElementById("practiceCents");
        const tEl = document.getElementById("practiceTonic");
        const iEl = document.getElementById("practiceInterval");

        if (tEl) tEl.textContent = midiToName(practiceRefMidi);
        if (iEl) iEl.textContent = practiceIntervals.map(x => x.short).join(" · ");

        if (s) { s.textContent = "Sing your selected targets"; s.className = "refstatus"; }
        if (c) c.textContent = "";
      }
    }

    drawSpectrogramColumn(ctx, lin, micCtx.sampleRate, analyser.fftSize, canvas, picks, MAX_HZ);
    rafId = requestAnimationFrame(loop);
  }

  loop();
}

function stopMic() {
  const startBtn = document.getElementById("start");
  const stopBtn  = document.getElementById("stop");
  const status   = document.getElementById("status");
  const out      = document.getElementById("out");

  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;

  if (analyser) analyser.disconnect();
  analyser = null;

  if (micCtx) micCtx.close();
  micCtx = null;

  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }

  out.textContent = "—";
  status.textContent = "Idle";
  document.getElementById("dot")?.classList.remove("live");
  renderPitchCards([]);

  startBtn.disabled = false;
  stopBtn.disabled = true;
}

// wire up
window.addEventListener("DOMContentLoaded", () => {
  renderPitchCards([]);
  buildPracticeUI();

  document.getElementById("start")?.addEventListener("click", () => {
    startMic().catch(err => {
      const st = document.getElementById("status");
      if (st) st.textContent = "Error: " + err.message;
      document.getElementById("dot")?.classList.remove("live");
    });
  });

  document.getElementById("stop")?.addEventListener("click", () => stopMic());
});
