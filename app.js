let micCtx = null;
let analyser = null;
let stream = null;
let rafId = null;

let mediaRecorder = null;
let recordingChunks = [];
let recordingStartedAt = 0;
let recordingTimerId = null;
let recordingMime = "";
let recordingExt = "webm";
let recordingUrl = null;

// --- Notes / helpers ---
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const A4 = 440;

// Accuracy thresholds (cents)
const IN_TUNE_CENTS = 5;
const CLOSE_CENTS   = 15;

// Spectrogram parameters
const MAX_HZ = 6500;
const LABEL_W = 190; // piano sidebar cap
let spectrogramSpeed = 0.5;

// Pitch detection parameters
const PITCH_ANALYSIS_MAX_HZ = 4000;
const DETECT_MIN_HZ = 55;
const DETECT_MAX_HZ = 1400;
const CAND_STEP_CENTS = 8;
const MIN_PICK_SEMITONES = 0.55;
const MAX_TRACK_AGE = 8;
const RUMBLE_HZ = 85;
const VISUAL_FLOOR_MULT = 2.15;
const VISUAL_IDLE_FLOOR_MULT = 4.8;

const RECORDING_TYPES = [
  { mime: "video/mp4;codecs=h264,aac", ext: "mp4", label: "MP4" },
  { mime: "video/mp4", ext: "mp4", label: "MP4" },
  { mime: "video/webm;codecs=vp9,opus", ext: "webm", label: "WebM" },
  { mime: "video/webm;codecs=vp8,opus", ext: "webm", label: "WebM" },
  { mime: "video/webm", ext: "webm", label: "WebM" }
];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function centsBetween(freq, target) { return 1200 * Math.log2(freq / target); }
function absCents(note) { return Math.abs(note?.cents ?? 999); }

function percentile(values, p) {
  if (!values || values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const idx = clamp(Math.floor(sorted.length * p), 0, sorted.length - 1);
  return sorted[idx] || 0;
}

function isProbablySafari() {
  const ua = navigator.userAgent;
  return /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua);
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function chooseRecordingType() {
  const types = getSupportedRecordingTypes();
  return types[0] || null;
}

function getSupportedRecordingTypes() {
  if (!window.MediaRecorder) return [];
  return RECORDING_TYPES.filter(type => !type.mime || MediaRecorder.isTypeSupported(type.mime));
}

function setRecordStatus(text, cls = "") {
  const el = document.getElementById("recordStatus");
  if (!el) return;
  el.textContent = text;
  el.className = `record-status ${cls}`.trim();
}

function setDownloadRecording(blob, ext) {
  const link = document.getElementById("downloadRecording");
  if (!link) return;

  if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  recordingUrl = URL.createObjectURL(blob);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const mb = blob.size / (1024 * 1024);
  link.href = recordingUrl;
  link.download = `chordtuner-session-${stamp}.${ext}`;
  link.textContent = `Download ${ext.toUpperCase()} (${mb.toFixed(1)} MB)`;
  link.hidden = false;
}

function resetRecordingDownload() {
  const link = document.getElementById("downloadRecording");
  if (recordingUrl) URL.revokeObjectURL(recordingUrl);
  recordingUrl = null;
  if (link) {
    link.href = "#";
    link.hidden = true;
    link.textContent = "Download";
  }
}

function updateRecordingButtons() {
  const recordBtn = document.getElementById("record");
  const stopRecordBtn = document.getElementById("stopRecord");
  const supported = !!chooseRecordingType();
  const hasSession = !!stream;
  const isRecording = mediaRecorder && mediaRecorder.state === "recording";

  if (recordBtn) recordBtn.disabled = !hasSession || !supported || isRecording;
  if (stopRecordBtn) stopRecordBtn.disabled = !isRecording;

  if (!supported) setRecordStatus("Recording unsupported", "warn");
  else if (!hasSession && !isRecording) setRecordStatus("Recording off");
}

function startRecordingTimer(label) {
  clearInterval(recordingTimerId);
  recordingStartedAt = Date.now();
  setRecordStatus(`Recording ${formatClock(0)} · ${label}`, "live");
  recordingTimerId = setInterval(() => {
    setRecordStatus(`Recording ${formatClock(Date.now() - recordingStartedAt)} · ${label}`, "live");
  }, 500);
}

function stopRecordingTimer() {
  clearInterval(recordingTimerId);
  recordingTimerId = null;
}

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
    const confidence = clamp(p.confidence ?? 0, 0, 1);
    const confText = `${Math.round(confidence * 100)}%`;

    return `
      <div class="pitch ${cls}">
        <div>
          <div class="note">${p.note.name}</div>
          <div class="meta">${p.freq.toFixed(1)} Hz · ${confText}</div>
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

function maxAroundBin(mag, center, radius) {
  const lo = Math.max(0, center - radius);
  const hi = Math.min(mag.length - 1, center + radius);
  let best = 0;
  let bestIdx = center;

  for (let i = lo; i <= hi; i++) {
    if (mag[i] > best) {
      best = mag[i];
      bestIdx = i;
    }
  }

  return { value: best, idx: bestIdx };
}

function parabolicBinOffset(mag, idx) {
  if (idx <= 0 || idx >= mag.length - 1) return 0;
  const a = mag[idx - 1];
  const b = mag[idx];
  const c = mag[idx + 1];
  const den = a - 2 * b + c;
  if (Math.abs(den) < 1e-12) return 0;
  return clamp(0.5 * (a - c) / den, -0.5, 0.5);
}

function conditionSpectrum(lin, sampleRate, fftSize, maxHz = MAX_HZ) {
  const binHz = sampleRate / fftSize;
  const maxBin = Math.min(lin.length - 1, Math.floor(maxHz / binHz));
  const conditioned = new Float32Array(lin.length);

  const samples = [];
  const step = Math.max(1, Math.floor(maxBin / 512));
  for (let i = 1; i <= maxBin; i += step) samples.push(lin[i]);

  const noise = Math.max(percentile(samples, 0.55), 1e-9);
  const peak = Math.max(percentile(samples, 0.995), noise);
  const range = Math.max(peak - noise, 1e-9);

  for (let i = 1; i <= maxBin; i++) {
    const gated = Math.max(0, lin[i] - noise * 1.35);
    conditioned[i] = Math.log1p((gated / range) * 24);
  }

  // Gentle spectral whitening keeps vowels, instrument timbre, and loud
  // upper partials from dominating the fundamental score.
  const whitened = new Float32Array(lin.length);
  for (let i = 1; i <= maxBin; i++) {
    const r = Math.max(3, Math.round(i * 0.035));
    const lo = Math.max(1, i - r);
    const hi = Math.min(maxBin, i + r);
    let local = 0;
    for (let j = lo; j <= hi; j++) local += conditioned[j];
    local /= (hi - lo + 1);
    whitened[i] = conditioned[i] / Math.sqrt(local + 0.06);
  }

  return { mag: whitened, noise, peak, binHz, maxBin };
}

function analyzeMicEnergy(lin, sampleRate, fftSize, maxHz = MAX_HZ) {
  const binHz = sampleRate / fftSize;
  const usableMax = Math.min(lin.length, Math.floor(maxHz / binHz));
  const rumbleBin = Math.min(usableMax, Math.max(1, Math.floor(RUMBLE_HZ / binHz)));
  let max = 0;
  let musicalMax = 0;
  let sum = 0;
  let musicalSum = 0;
  let musicalCount = 0;

  for (let i = 1; i < usableMax; i++) {
    const v = lin[i];
    if (v > max) max = v;
    sum += v;

    if (i >= rumbleBin) {
      if (v > musicalMax) musicalMax = v;
      musicalSum += v;
      musicalCount += 1;
    }
  }

  const avg = sum / Math.max(1, usableMax - 1);
  const musicalAvg = musicalSum / Math.max(1, musicalCount);
  const isQuiet = musicalMax < 1.8e-4 || musicalMax < musicalAvg * 5.5 || musicalMax < max * 0.22;

  return { max, avg, musicalMax, musicalAvg, isQuiet };
}

function harmonicScore(mag, binHz, f0, maxBin, maxHz = MAX_HZ) {
  let score = 0;
  let weightSum = 0;
  let evidence = 0;
  let firstHarmonic = 0;
  let strongest = 0;

  for (let h = 1; h <= 10; h++) {
    const fh = f0 * h;
    if (fh > maxHz) break;

    const center = Math.round(fh / binHz);
    if (center < 1 || center > maxBin) continue;

    const radius = Math.max(1, Math.round(center * 0.006));
    const { value } = maxAroundBin(mag, center, radius);
    const weight = 1 / Math.pow(h, 0.78);

    score += value * weight;
    weightSum += weight;
    strongest = Math.max(strongest, value);
    if (h === 1) firstHarmonic = value;
    if (value > 0.16) evidence++;
  }

  if (weightSum === 0) return { score: 0, evidence: 0, firstHarmonic: 0, strongest: 0 };

  const normalized = score / weightSum;
  const presence = clamp(evidence / 4, 0, 1);
  const fundamentalSupport = strongest > 0 ? clamp(firstHarmonic / strongest, 0, 1) : 0;
  const missingFundamentalAllowance = firstHarmonic > 0.10 ? 1 : 0.72;

  return {
    score: normalized * (0.65 + 0.35 * presence) * (0.72 + 0.28 * fundamentalSupport) * missingFundamentalAllowance,
    evidence,
    firstHarmonic,
    strongest
  };
}

function refineCandidateFreq(mag, binHz, f0, maxBin) {
  const center = Math.round(f0 / binHz);
  if (center < 1 || center >= maxBin) return f0;
  const radius = Math.max(1, Math.round(center * 0.006));
  const { idx } = maxAroundBin(mag, center, radius);
  const offset = parabolicBinOffset(mag, idx);
  const refined = (idx + offset) * binHz;

  if (!isFinite(refined) || refined <= 0) return f0;
  const cents = Math.abs(centsBetween(refined, f0));
  return cents <= 45 ? refined : f0;
}

function isLikelyOvertoneOf(freq, selected) {
  for (const p of selected) {
    for (let h = 2; h <= 6; h++) {
      const cents = Math.abs(centsBetween(freq, p.freq * h));
      if (cents < 34 && (p.confidence ?? 0) >= 0.72) return true;
    }
  }
  return false;
}

function multiPitchFromSpectrum(lin, sampleRate, fftSize, k = 3, fmin = DETECT_MIN_HZ, fmax = DETECT_MAX_HZ) {
  const { mag, binHz, maxBin } = conditionSpectrum(lin, sampleRate, fftSize, PITCH_ANALYSIS_MAX_HZ);
  const minHz = Math.max(fmin, binHz * 2);
  const maxHz = Math.min(fmax, PITCH_ANALYSIS_MAX_HZ * 0.75);
  const steps = Math.max(1, Math.ceil(1200 * Math.log2(maxHz / minHz) / CAND_STEP_CENTS));
  const candidates = [];

  for (let i = 0; i <= steps; i++) {
    const f0 = minHz * Math.pow(2, (i * CAND_STEP_CENTS) / 1200);
    const base = harmonicScore(mag, binHz, f0, maxBin, PITCH_ANALYSIS_MAX_HZ);
    if (base.score <= 0) continue;

    let subPenalty = 0;
    for (const div of [2, 3, 4]) {
      const sub = f0 / div;
      if (sub >= minHz) {
        subPenalty = Math.max(subPenalty, harmonicScore(mag, binHz, sub, maxBin, PITCH_ANALYSIS_MAX_HZ).score);
      }
    }

    const score = Math.max(0, base.score - subPenalty * 0.28);
    candidates.push({ freq: f0, score, rawScore: base.score, evidence: base.evidence });
  }

  if (candidates.length === 0) return [];

  const smoothed = candidates.map((c, idx) => {
    const prev = candidates[idx - 1]?.score ?? c.score;
    const next = candidates[idx + 1]?.score ?? c.score;
    return { ...c, score: c.score * 0.62 + prev * 0.19 + next * 0.19 };
  });

  const peaks = smoothed.filter((c, idx) => {
    const prev = smoothed[idx - 1]?.score ?? -Infinity;
    const next = smoothed[idx + 1]?.score ?? -Infinity;
    return c.score >= prev && c.score >= next && c.evidence >= 2;
  });

  const bestScore = Math.max(...peaks.map(c => c.score), 0);
  const floor = Math.max(bestScore * 0.28, 0.035);
  const order = peaks
    .filter(c => c.score >= floor)
    .sort((a, b) => b.score - a.score);

  const selected = [];
  for (const c of order) {
    const freq = refineCandidateFreq(mag, binHz, c.freq, maxBin);
    const tooClose = selected.some(p => Math.abs(Math.log2(freq / p.freq) * 12) < MIN_PICK_SEMITONES);
    if (tooClose) continue;

    if (isLikelyOvertoneOf(freq, selected)) continue;

    selected.push({
      freq,
      score: c.score,
      confidence: bestScore > 0 ? clamp(c.score / bestScore, 0, 1) : 0,
      note: freqToETNote(freq)
    });

    if (selected.length >= k) break;
  }

  return selected.filter(x => x.note).sort((a, b) => a.freq - b.freq);
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
let specScrollAccum = 0;
let specVisualPeak = 1e-9;

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

function colorForSpectrogram(v) {
  const x = clamp(v, 0, 1);

  if (x < 0.18) {
    const t = x / 0.18;
    return {
      r: Math.round(0 + 8 * t),
      g: Math.round(0 + 18 * t),
      b: Math.round(8 + 42 * t)
    };
  }

  if (x < 0.55) {
    const t = (x - 0.18) / 0.37;
    return {
      r: Math.round(8 + 22 * t),
      g: Math.round(18 + 135 * t),
      b: Math.round(50 + 205 * t)
    };
  }

  if (x < 0.82) {
    const t = (x - 0.55) / 0.27;
    return {
      r: Math.round(30 + 125 * t),
      g: Math.round(153 + 82 * t),
      b: Math.round(255 - 15 * t)
    };
  }

  const t = (x - 0.82) / 0.18;
  return {
    r: Math.round(155 + 100 * t),
    g: Math.round(235 + 20 * t),
    b: Math.round(240 - 70 * t)
  };
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

function drawSpectrogramColumn(ctx, lin, sampleRate, fftSize, canvas, picks, maxHz = MAX_HZ, options = {}) {
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
    specScrollAccum = 0;
    specVisualPeak = 1e-9;
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
  const noise = samples[Math.floor(samples.length * 0.58)] || 1e-9;
  const p96 = samples[Math.floor(samples.length * 0.96)] || noise;
  const p995 = samples[Math.floor(samples.length * 0.995)] || p96 || noise;
  const isQuiet = !!options.quiet || p995 < noise * 5.2;
  const floor = noise * (isQuiet ? VISUAL_IDLE_FLOOR_MULT : VISUAL_FLOOR_MULT);
  const targetPeak = Math.max(p995 - floor, (p96 - floor) * 2.4, 1e-9);
  specVisualPeak = Math.max(targetPeak, specVisualPeak * (isQuiet ? 0.88 : 0.94));
  const normDen = Math.max(specVisualPeak, 1e-9);

  specScrollAccum += spectrogramSpeed;
  const columns = Math.floor(specScrollAccum);
  if (columns < 1) {
    ctx.putImageData(specImg, 0, 0);
    drawPianoSidebar(ctx, maxHz, w, h, plotX0);
    return;
  }
  specScrollAccum -= columns;

  for (let c = 0; c < columns; c++) {
    const x = plotX0 + specX;

    for (let y = 0; y < h; y++) {
      const bin = map[y];
      const prev = specImg.data[(y * w + x) * 4 + 2] / 255;
      const neighbor = bin > 0 ? (lin[bin - 1] + lin[bin] + (lin[bin + 1] || lin[bin])) / 3 : lin[bin];
      const freq = bin * binHz;
      const rumbleFade = clamp((freq - 45) / (RUMBLE_HZ * 1.7 - 45), 0.08, 1);
      const aboveFloor = Math.max(0, neighbor - floor);
      const norm = (aboveFloor * rumbleFade) / normDen;
      const clipped = clamp(norm, 0, 1);
      const boosted = Math.pow(clipped, isQuiet ? 0.62 : 0.42) * (isQuiet ? 0.28 : 1);
      const mixed = Math.max(boosted, prev * 0.08);
      const { r, g, b } = colorForSpectrogram(mixed);

      const idx = (y * w + x) * 4;
      specImg.data[idx + 0] = r;
      specImg.data[idx + 1] = g;
      specImg.data[idx + 2] = b;
      specImg.data[idx + 3] = 255;
    }

    specX = (specX + 1) % plotW;
  }

  ctx.putImageData(specImg, 0, 0);
  drawPianoSidebar(ctx, maxHz, w, h, plotX0);

  const x = plotX0 + ((specX + plotW - 1) % plotW);
  ctx.fillStyle = "rgba(90,185,255,0.20)";
  ctx.fillRect(x, 0, 1, h);

  drawPitchDots(ctx, picks, x, maxHz, h, lin, sampleRate, fftSize);
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
   Pitch tracking / smoothing
------------------------------ */

let pitchTracks = [];
let nextTrackId = 1;

function resetPitchTracks() {
  pitchTracks = [];
  nextTrackId = 1;
}

function stabilizePicks(rawPicks, maxCount = 3) {
  for (const track of pitchTracks) {
    track.matched = false;
    track.age += 1;
    track.confidence *= 0.86;
  }

  for (const pick of rawPicks) {
    let best = null;
    let bestCents = Infinity;

    for (const track of pitchTracks) {
      const cents = Math.abs(centsBetween(pick.freq, track.freq));
      if (cents < bestCents && cents <= 70) {
        best = track;
        bestCents = cents;
      }
    }

    if (best) {
      const blend = bestCents < 25 ? 0.34 : 0.52;
      best.freq = best.freq * (1 - blend) + pick.freq * blend;
      best.note = freqToETNote(best.freq);
      best.score = Math.max(best.score * 0.78, pick.score || 0);
      best.confidence = clamp(best.confidence * 0.62 + (pick.confidence ?? 0) * 0.48, 0, 1);
      best.age = 0;
      best.hits += 1;
      best.matched = true;
    } else {
      pitchTracks.push({
        id: nextTrackId++,
        freq: pick.freq,
        note: pick.note,
        score: pick.score || 0,
        confidence: pick.confidence ?? 0,
        hits: 1,
        age: 0,
        matched: true
      });
    }
  }

  pitchTracks = pitchTracks
    .filter(t => t.age <= MAX_TRACK_AGE && t.confidence >= 0.08)
    .sort((a, b) => {
      const aRank = a.confidence + Math.min(a.hits, 5) * 0.035 - a.age * 0.025;
      const bRank = b.confidence + Math.min(b.hits, 5) * 0.035 - b.age * 0.025;
      return bRank - aRank;
    })
    .slice(0, 8);

  return pitchTracks
    .filter(t => t.hits >= 2 || t.confidence >= 0.72)
    .slice(0, maxCount)
    .map(t => ({
      freq: t.freq,
      note: t.note,
      score: t.score,
      confidence: clamp(t.confidence - t.age * 0.05, 0, 1)
    }))
    .sort((a, b) => a.freq - b.freq);
}

/* -----------------------------
   Session recording
------------------------------ */

function createRecordingStream() {
  const canvas = document.getElementById("spec");
  if (!canvas || !stream) return null;

  const canvasStream = canvas.captureStream ? canvas.captureStream(24) : null;
  if (!canvasStream) return null;

  const mixed = new MediaStream();
  for (const track of canvasStream.getVideoTracks()) mixed.addTrack(track);
  for (const track of stream.getAudioTracks()) mixed.addTrack(track);
  return mixed;
}

function recordingBitrateFor(type) {
  const isMp4 = type?.ext === "mp4";
  return {
    videoBitsPerSecond: isMp4 ? 900_000 : 700_000,
    audioBitsPerSecond: 96_000
  };
}

function startSessionRecording() {
  const status = document.getElementById("status");
  const supportedTypes = getSupportedRecordingTypes() || [];
  let type = supportedTypes[0] || null;

  if (!type) {
    setRecordStatus("Recording is not supported in this browser", "warn");
    return;
  }

  if (!stream) {
    setRecordStatus("Begin a session before recording", "warn");
    return;
  }

  if (isProbablySafari()) {
    const ok = window.confirm(
      "Session recording works best in Chrome, Edge, or Firefox. Safari recording support can vary, especially for downloaded video files. Try recording anyway?"
    );
    if (!ok) return;
  }

  const capture = createRecordingStream();
  if (!capture) {
    setRecordStatus("Recording needs canvas capture support", "warn");
    return;
  }

  resetRecordingDownload();
  recordingChunks = [];
  recordingMime = type.mime;
  recordingExt = type.ext;

  let lastErr = null;
  for (const candidate of supportedTypes) {
    try {
      mediaRecorder = new MediaRecorder(capture, {
        mimeType: candidate.mime,
        ...recordingBitrateFor(candidate)
      });
      type = candidate;
      break;
    } catch (err) {
      lastErr = err;
      mediaRecorder = null;
    }
  }

  if (!mediaRecorder) {
    setRecordStatus(`Recording error: ${lastErr?.message || "unsupported format"}`, "warn");
    capture.getTracks().forEach(t => t.stop());
    updateRecordingButtons();
    return;
  }

  mediaRecorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) recordingChunks.push(event.data);
  });

  mediaRecorder.addEventListener("stop", () => {
    stopRecordingTimer();
    capture.getTracks().forEach(t => t.stop());

    const blob = new Blob(recordingChunks, { type: recordingMime || type.mime });
    recordingChunks = [];
    mediaRecorder = null;

    if (blob.size > 0) {
      setDownloadRecording(blob, recordingExt);
      setRecordStatus(`Recording ready · ${type.label}`, "ready");
    } else {
      setRecordStatus("Recording ended with no data", "warn");
    }

    updateRecordingButtons();
  });

  mediaRecorder.addEventListener("error", (event) => {
    stopRecordingTimer();
    setRecordStatus(`Recording error: ${event.error?.message || "unknown"}`, "warn");
    updateRecordingButtons();
  });

  mediaRecorder.start(1000);
  startRecordingTimer(type.label);
  if (status) status.textContent = "Listening + recording…";
  updateRecordingButtons();
}

function stopSessionRecording() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  mediaRecorder.stop();
  setRecordStatus("Preparing recording…", "ready");
  updateRecordingButtons();
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
  let quietFrames = 0;
  resetPitchTracks();

  startBtn.disabled = true;
  stopBtn.disabled = false;
  resetRecordingDownload();

  status.textContent = "Listening…";
  document.getElementById("dot")?.classList.add("live");
  updateRecordingButtons();

  function loop() {
    analyser.getFloatFrequencyData(db);

    for (let i = 0; i < bins; i++) {
      const v = db[i];
      lin[i] = (v === -Infinity) ? 0 : Math.pow(10, v / 20);
    }

    const energy = analyzeMicEnergy(lin, micCtx.sampleRate, analyser.fftSize, PITCH_ANALYSIS_MAX_HZ);

    let picks = [];

    if (energy.isQuiet) {
      quietFrames += 1;
      if (quietFrames > 5) resetPitchTracks();
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
      quietFrames = 0;
      const rawPicks = multiPitchFromSpectrum(lin, micCtx.sampleRate, analyser.fftSize, 3);
      picks = stabilizePicks(rawPicks, 3);

      out.textContent = picks.length
        ? picks.map(p => `${p.note.name}  ${p.freq.toFixed(1)} Hz  (${p.note.cents.toFixed(0)} cents, ${Math.round((p.confidence ?? 0) * 100)}% confidence)`).join("\n")
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

    drawSpectrogramColumn(ctx, lin, micCtx.sampleRate, analyser.fftSize, canvas, picks, MAX_HZ, {
      quiet: quietFrames > 2
    });
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
  resetPitchTracks();

  const wasRecording = mediaRecorder && mediaRecorder.state !== "inactive";
  if (wasRecording) stopSessionRecording();

  if (analyser) analyser.disconnect();
  analyser = null;

  if (micCtx) micCtx.close();
  micCtx = null;

  const stopInputStream = () => {
    if (!stream) return;
    stream.getTracks().forEach(t => t.stop());
    stream = null;
    updateRecordingButtons();
  };

  if (wasRecording) setTimeout(stopInputStream, 800);
  else stopInputStream();

  out.textContent = "—";
  status.textContent = "Idle";
  document.getElementById("dot")?.classList.remove("live");
  renderPitchCards([]);

  startBtn.disabled = false;
  stopBtn.disabled = true;
  if (!wasRecording) updateRecordingButtons();
}

function setupSpectrogramControls() {
  const speed = document.getElementById("specSpeed");
  const label = document.getElementById("specSpeedLabel");
  if (!speed || !label) return;

  const apply = () => {
    spectrogramSpeed = clamp(parseFloat(speed.value) || 0.5, 0.25, 1.5);
    label.textContent = `${spectrogramSpeed.toFixed(2).replace(/\.00$/, "").replace(/0$/, "")}x`;
  };

  speed.addEventListener("input", apply);
  apply();
}

// wire up
window.addEventListener("DOMContentLoaded", () => {
  renderPitchCards([]);
  buildPracticeUI();
  setupSpectrogramControls();
  updateRecordingButtons();

  document.getElementById("start")?.addEventListener("click", () => {
    startMic().catch(err => {
      const st = document.getElementById("status");
      if (st) st.textContent = "Error: " + err.message;
      document.getElementById("dot")?.classList.remove("live");
    });
  });

  document.getElementById("stop")?.addEventListener("click", () => stopMic());
  document.getElementById("record")?.addEventListener("click", () => startSessionRecording());
  document.getElementById("stopRecord")?.addEventListener("click", () => stopSessionRecording());
});
