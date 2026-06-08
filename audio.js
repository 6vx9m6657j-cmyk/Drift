// ════════════════════════════════════════════════════════════════════
//  audio.js — Tone.js 音楽エンジン
//  依存: camera.js（canvas）, paths.js（verts, stableVerts, MAX_PATHS）
// ════════════════════════════════════════════════════════════════════

// ── PIANO NOTES: Dm7 × 2oct（完全協和、複数同時発音で自然和音）──
const PATH_NOTES = ['D3', 'F3', 'A3', 'C4', 'D4', 'F4', 'A4', 'C5'];
const MAX_PATHS  = 8;

// ── ENVIRONMENTAL STATS ──
let envStats = { meanX: 0, meanY: 0, variance: 0, energy: 0, density: 0, flow: 0 };
let _pMX = 0, _pMY = 0;

function computeStats(pts, W, H) {
  if (!pts || pts.length === 0) return null;
  const cx = W / 2, cy = H / 2, n = pts.length;
  let sX = 0, sY = 0;
  for (const v of pts) { sX += (v[0] - cx) / (W / 2); sY += (v[1] - cy) / (H / 2); }
  const mX = sX / n, mY = sY / n;
  let vSum = 0, eSum = 0;
  for (const v of pts) {
    const nx = (v[0] - cx) / (W / 2), ny = (v[1] - cy) / (H / 2);
    vSum += (nx - mX) ** 2 + (ny - mY) ** 2;
    eSum += Math.sqrt((v[0] - cx) ** 2 + (v[1] - cy) ** 2);
  }
  return {
    meanX:    mX, meanY: mY,
    variance: Math.min(1, vSum / n / 2),
    energy:   Math.min(1, eSum / n / Math.sqrt((W / 2) ** 2 + (H / 2) ** 2)),
    density:  Math.min(1, n / 8),
    flow:     Math.abs(mX - _pMX) + Math.abs(mY - _pMY),
  };
}

function smoothStats(raw) {
  const a = 0.36;
  if (!raw) {
    envStats.density += (0 - envStats.density) * 0.12;
    envStats.flow    += (0 - envStats.flow)    * 0.18;
    return;
  }
  envStats.meanX    += (raw.meanX    - envStats.meanX)    * a;
  envStats.meanY    += (raw.meanY    - envStats.meanY)    * a;
  envStats.variance += (raw.variance - envStats.variance) * a;
  envStats.energy   += (raw.energy   - envStats.energy)   * a;
  envStats.density  += (raw.density  - envStats.density)  * a;
  envStats.flow     += (raw.flow     - envStats.flow)     * 0.28;
  _pMX = raw.meanX; _pMY = raw.meanY;
}

// ── BPM ──
const userBpm   = 84;
let   smoothBpm = 84;

// ── PIANO STATE: per-path オシレーター + Gain ──
let pathGains        = [];
let pathActVol       = [];
// X方向運動量(dx) → FX スムージング状態
let pathChorusSmooth = 0;
let pathDelaySmooth  = 0;
let pathFilterSmooth = 600;
let pathChorus, pathDelay, pathLPF;

// ── GUITAR STATE ──
let gPrevFlow       = 0;
let gPrevEnergy     = 0;
let gPrevCount      = 0;
let guitarRestUntil = -1;

// ── DRUM STATE ──
let drumStep = 0;

// ── SYNTH NODES ──
let toneReady = false;
let guitarSynth;
let kickSynth, snareSynth, hatSynth;

// ── KINEMATIC STATE ──
let kinetics = {
  speed: 0, prevSpeed: 0, accel: 0,
  flowX: 0, flowY: 0, curvature: 0, crossing: false,
};

// ── ACTIVITY ──
let activityAlpha = 0;

// ── ATMOSPHERE ──
let atmGain;

// ── AUDIO → VISUAL フィードバック ──
let vfKick   = 0;   // kick   → ライン太さパルス
let vfHat    = 0;   // hat    → 微粒子スパーク
let vfGuitar = 0;   // guitar → 頂点グロウ

// ────────────────────────────────────────────
//  initAudio — Tone.js 全ノード初期化
// ────────────────────────────────────────────
async function initAudio() {
  await Tone.start();
  await Tone.context.resume();

  const masterLimiter = new Tone.Limiter(-1).toDestination();

  // リバーブ並列生成
  const pianoReverb  = new Tone.Reverb({ decay: 6.5, wet: 0.55 });
  const guitarReverb = new Tone.Reverb({ decay: 8.0, wet: 0.38 });
  const snareRev     = new Tone.Reverb({ decay: 1.4, wet: 0.24 });
  const atmReverb    = new Tone.Reverb({ decay: 9.0, wet: 0.88 });
  await Promise.all([
    pianoReverb.generate(), guitarReverb.generate(),
    snareRev.generate(),    atmReverb.generate(),
  ]);

  // ─ Piano: 8本固定オシレーター + 個別 Gain
  //   FX chain: pathLPF → pathChorus → pathDelay → pianoReverb → master
  //   dx で Chorus/Delay/Filter をリアルタイム変調
  pathChorus = new Tone.Chorus({ frequency: 0.5, delayTime: 4.0, depth: 0.10, wet: 0.05 }).start();
  pathDelay  = new Tone.FeedbackDelay({ delayTime: '8n', feedback: 0.20, wet: 0.05 });
  pathLPF    = new Tone.Filter({ frequency: 600, type: 'lowpass', rolloff: -24 });

  for (let i = 0; i < MAX_PATHS; i++) {
    const gain = new Tone.Gain(0);
    const osc  = new Tone.Oscillator(
      Tone.Frequency(PATH_NOTES[i]).toFrequency(), 'sine'
    ).start();
    osc.connect(gain);
    gain.chain(pathLPF, pathChorus, pathDelay, pianoReverb, masterLimiter);
    pathGains.push(gain);
    pathActVol.push(0);
  }

  // ─ Guitar: e-bow / shimmer
  const guitarLPF      = new Tone.Filter({ frequency: 2400, type: 'lowpass' });
  const guitarChorus   = new Tone.Chorus({ frequency: 0.4, delayTime: 3.8, depth: 0.88, wet: 0.75 }).start();
  const guitarPingPong = new Tone.PingPongDelay({ delayTime: '4n', feedback: 0.38, wet: 0.34 });
  guitarSynth = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 2,
    oscillator:  { type: 'sine' },
    envelope:    { attack: 2.5, decay: 0, sustain: 1.0, release: 3.0 },
    volume: -18,
  });
  guitarSynth.chain(guitarLPF, guitarChorus, guitarPingPong, guitarReverb, masterLimiter);

  // ─ Kick
  kickSynth = new Tone.MembraneSynth({
    pitchDecay: 0.07, octaves: 7,
    envelope:   { attack: 0.001, decay: 0.30, sustain: 0, release: 0.18 },
    volume: -3,
  });
  kickSynth.connect(masterLimiter);

  // ─ Snare
  snareSynth = new Tone.NoiseSynth({
    noise:    { type: 'white' },
    envelope: { attack: 0.001, decay: 0.20, sustain: 0, release: 0.08 },
    volume: -12,
  });
  snareSynth.chain(snareRev, masterLimiter);

  // ─ Hi-hat
  hatSynth = new Tone.NoiseSynth({
    noise:    { type: 'pink' },
    envelope: { attack: 0.001, decay: 0.055, sustain: 0, release: 0.022 },
    volume: -18,
  });
  hatSynth.connect(masterLimiter);

  // ─ Atmosphere: 風・空気テクスチャ
  const atmNoise = new Tone.Noise('brown').start();
  const atmBPF   = new Tone.Filter({ frequency: 260, type: 'bandpass', Q: 0.7 });
  const atmLFO   = new Tone.LFO({ frequency: 0.07, min: 180, max: 500 }).start();
  atmLFO.connect(atmBPF.frequency);
  atmGain = new Tone.Gain(0.0);
  atmNoise.chain(atmBPF, atmGain, atmReverb, masterLimiter);

  Tone.Transport.bpm.value = smoothBpm;
  new Tone.Loop(t => onDrumTick(t), '16n').start(0);
  Tone.Transport.start();

  toneReady = true;
}

// ────────────────────────────────────────────
//  resumeAudio — iOS バックグラウンド復帰対策
// ────────────────────────────────────────────
async function resumeAudio() {
  if (!toneReady) return;
  try {
    if (Tone.context.state !== 'running') await Tone.context.resume();
    if (Tone.Transport.state !== 'started') Tone.Transport.start();
  } catch (e) {}
}

// iOS が AudioContext をサイレントに停止するケースへの保険
setInterval(() => {
  if (toneReady && Tone.context.state !== 'running')
    Tone.context.resume().catch(() => {});
}, 2000);

// ────────────────────────────────────────────
//  ACTIVITY STATE — 密度 → 活性度 (0-1)
// ────────────────────────────────────────────
function updateActivityState() {
  const target = Math.min(1, Math.max(0, (envStats.density - 0.03) / 0.22));
  activityAlpha += (target - activityAlpha) * 0.12;
}

// ────────────────────────────────────────────
//  DRUM ENGINE — 固定 4/4 テクノパターン
// ────────────────────────────────────────────
function onDrumTick(time) {
  smoothBpm += (userBpm - smoothBpm) * 0.05;
  Tone.Transport.bpm.value = smoothBpm;

  const step = drumStep % 16;

  // Kick: 1・3拍目
  if (step === 0 || step === 8) {
    kickSynth.triggerAttackRelease('C1', '8n', time, 0.82);
    vfKick = 1.0;
  }
  // Snare: 2・4拍目
  if (step === 4 || step === 12) {
    snareSynth.triggerAttackRelease('8n', time, 0.65);
  }
  // Hi-hat: 8分音符
  if (step % 2 === 0) {
    const hvel = step % 4 === 2 ? 0.28 : 0.18;
    hatSynth.triggerAttackRelease('32n', time, hvel);
    vfHat = Math.max(vfHat, 0.40);
  }

  drumStep++;
  checkGuitarTrigger(time);
}

// ────────────────────────────────────────────
//  GUITAR ENGINE — 環境変化の瞬間にのみ発音
// ────────────────────────────────────────────
function checkGuitarTrigger(time) {
  if (time < guitarRestUntil) return;
  if (envStats.density < 0.10) return;

  const dFlow   = envStats.flow   - gPrevFlow;
  const dEnergy = Math.abs(envStats.energy - gPrevEnergy);
  const dCount  = Math.abs(verts.length    - gPrevCount);
  const triggered = dFlow > 0.020 || dEnergy > 0.06 || dCount >= 2;

  if (triggered && Math.random() < 0.55) {
    triggerGuitarShimmer(time);
    guitarRestUntil = time + 1.5 + Math.random() * 3.0;
  }
  gPrevFlow   = envStats.flow;
  gPrevEnergy = envStats.energy;
  gPrevCount  = verts.length;
}

function triggerGuitarShimmer(time) {
  // PATH_NOTES 上声部からランダムに 1〜2音（調性統一）
  const upper = ['D4', 'F4', 'A4', 'C5'];
  const count = Math.random() < 0.35 ? 2 : 1;
  const notes = [];
  const idx   = Math.floor(Math.random() * upper.length);
  for (let i = 0; i < count; i++) notes.push(upper[(idx + i) % upper.length]);
  guitarSynth.triggerAttackRelease(
    notes, 3.0 + Math.random() * 3.5, time, 0.07 + Math.random() * 0.10
  );
  vfGuitar = 0.6;
}

// ────────────────────────────────────────────
//  PATH PIANO — per-path オシレーター Gain 制御
//
//  Y軸上昇 > THRESH → Gain フェードイン（発音）
//  速度 → 音量ターゲット, 加速度 → フェードイン速度
//  PolySynth 不使用 → 急激な on/off 完全排除
// ────────────────────────────────────────────
function updatePathPiano() {
  if (!toneReady || pathGains.length === 0) return;
  const W      = canvas.width;
  const H      = canvas.height;
  const THRESH = H * 0.012;

  const targetVol   = new Array(MAX_PATHS).fill(0);
  const accelBySlot = new Array(MAX_PATHS).fill(0);

  for (let i = 0; i < stableVerts.length; i++) {
    const sv    = stableVerts[i];
    const slot  = (sv[5] ?? 0) % MAX_PATHS;
    const initY = sv[6] ?? sv[1];
    const isUp  = (initY - sv[1]) > THRESH;

    stableVerts[i][7] = isUp;  // playing フラグ更新
    if (!isUp) continue;

    const spd = Math.min(1, Math.sqrt((sv[3] || 0) ** 2 + (sv[4] || 0) ** 2) / (W * 0.010));
    targetVol[slot]   = Math.max(targetVol[slot],   Math.min(0.92, 0.32 + spd * 0.60));
    accelBySlot[slot] = Math.max(accelBySlot[slot], kinetics.accel);
  }

  for (let slot = 0; slot < MAX_PATHS; slot++) {
    const tgt = targetVol[slot];
    const cur = pathActVol[slot];
    if (tgt > cur) {
      // フェードイン: accel=0→~2s, accel=1→~0.7s
      pathActVol[slot] += (tgt - cur) * (0.010 + accelBySlot[slot] * 0.050);
    } else {
      // フェードアウト: ~1.5s リリース
      pathActVol[slot] += (tgt - cur) * 0.015;
    }
    pathGains[slot].gain.rampTo(Math.max(0, Math.min(1, pathActVol[slot])), 0.05);
  }
}

// ────────────────────────────────────────────
//  KINEMATIC COMPUTATION
//  頂点速度・加速度・曲率・交差 を算出
// ────────────────────────────────────────────
function computeKinematics() {
  if (verts.length === 0) {
    kinetics.speed    += (0 - kinetics.speed) * 0.12;
    kinetics.accel    += (0 - kinetics.accel) * 0.12;
    kinetics.curvature = 0;
    kinetics.crossing  = false;
    return;
  }
  const W = canvas.width, H = canvas.height;
  let rawSpeedSum = 0, flowXSum = 0, flowYSum = 0;
  for (const v of verts) {
    const vx = v[2] || 0, vy = v[3] || 0;
    rawSpeedSum += Math.sqrt(vx * vx + vy * vy);
    flowXSum += vx; flowYSum += vy;
  }
  const n = verts.length;
  const rawSpeed = Math.min(1, rawSpeedSum / (n * W * 0.012));
  kinetics.prevSpeed = kinetics.speed;
  kinetics.speed    += (rawSpeed - kinetics.speed) * 0.32;
  kinetics.flowX     = flowXSum / (n * W * 0.01);
  kinetics.flowY     = flowYSum / (n * H * 0.01);
  const accelRaw     = Math.min(1, Math.abs(kinetics.speed - kinetics.prevSpeed) * 7);
  kinetics.accel    += (accelRaw - kinetics.accel) * 0.30;
  kinetics.curvature = Math.min(1, (Math.abs(kinetics.flowX) + Math.abs(kinetics.flowY)) * 0.5);

  kinetics.crossing = false;
  const crossD2     = (W * 0.08) ** 2;
  outer: for (let i = 0; i < verts.length - 1; i++) {
    for (let j = i + 1; j < verts.length; j++) {
      const ddx = verts[i][0] - verts[j][0], ddy = verts[i][1] - verts[j][1];
      if (ddx * ddx + ddy * ddy < crossD2) { kinetics.crossing = true; break outer; }
    }
  }
}

// ────────────────────────────────────────────
//  updateAudio — 毎フレーム呼び出し
// ────────────────────────────────────────────
function updateAudio(pts) {
  if (!toneReady) return;

  const raw = computeStats(pts, canvas.width, canvas.height);
  smoothStats(raw);
  updateActivityState();
  computeKinematics();
  updatePathPiano();

  // X方向運動量(dx) → Chorus / Delay / Filter
  if (pathChorus && pathDelay && pathLPF) {
    let dxSum = 0, dxCount = 0;
    for (const sv of stableVerts) { dxSum += Math.abs(sv[3] || 0); dxCount++; }
    const avgDx   = dxCount > 0 ? Math.min(1, dxSum / dxCount / (canvas.width * 0.010)) : 0;
    const fxAlpha = 0.035;
    pathChorusSmooth += (avgDx - pathChorusSmooth) * fxAlpha;
    pathDelaySmooth  += (avgDx - pathDelaySmooth)  * fxAlpha;
    const filterTgt   = 600 + pathChorusSmooth * 2600;
    pathFilterSmooth += (filterTgt - pathFilterSmooth) * fxAlpha;
    pathChorus.wet.rampTo(0.04 + pathChorusSmooth * 0.52, 0.20);
    pathDelay.wet.rampTo( 0.03 + pathDelaySmooth  * 0.32, 0.20);
    pathLPF.frequency.rampTo(Math.max(400, pathFilterSmooth), 0.20);
  }

  if (atmGain) atmGain.gain.rampTo(activityAlpha * 0.035, 0.8);
}
