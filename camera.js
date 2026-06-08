// ════════════════════════════════════════════════════════════════════
//  camera.js — Canvas・カメラ・画面追従
//  依存: なし（最初に読み込む）
// ════════════════════════════════════════════════════════════════════

const canvas = document.getElementById('canvas');
const ctx    = canvas.getContext('2d');
const video  = document.getElementById('video');

// ── モバイル判定 & 処理用キャンバス ──
const isMobile   = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const FRAME_SKIP = isMobile ? 3 : 2;

const proc  = document.createElement('canvas');
const pCtx  = proc.getContext('2d', { willReadFrequently: true });
const PROC_W = isMobile ? 200 : 320;
const PROC_H = isMobile ? 150 : 240;
proc.width = PROC_W; proc.height = PROC_H;

// ── カメラ状態 ──
let currentStream = null;
let currentFacing = 'user';
let frameTick     = 0;

// ── Canvas を画面サイズへ自動追従 ──
// カメラ映像のアスペクト比を保ちつつ画面全体を覆う
function fitCanvas() {
  const vw = video.videoWidth  || 640;
  const vh = video.videoHeight || 480;
  const sw = window.innerWidth;
  const sh = window.innerHeight;
  const vR = vw / vh, sR = sw / sh;
  let cw, ch;
  if (vR > sR) { cw = sw; ch = Math.round(sw / vR); }
  else          { ch = sh; cw = Math.round(sh * vR); }

  canvas.width  = cw;
  canvas.height = ch;
  canvas.style.width  = cw + 'px';
  canvas.style.height = ch + 'px';
  canvas.style.left   = Math.round((sw - cw) / 2) + 'px';
  canvas.style.top    = Math.round((sh - ch) / 2) + 'px';

  // モーション検出状態をリセット（解像度変化後の誤検出防止）
  prevGray   = null;
  smoothDens = null;
  bgModel    = null;
  stableVerts = [];
}

// ── カメラストリーム起動 ──
async function startStream(facing) {
  if (currentStream) {
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: facing,
        width:  { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    });
  } catch (e) {
    // フォールバック: 制約なしで取得
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  }
  video.srcObject = stream;
  await video.play();
  currentStream = stream;
  currentFacing = facing;

  // モーション検出リセット
  prevGray   = null;
  smoothDens = null;
  bgModel    = null;
  stableVerts = [];

  if (video.readyState >= 1) fitCanvas();
  else video.addEventListener('loadedmetadata', fitCanvas, { once: true });
}

// ── 画面回転・リサイズ対応 ──
window.addEventListener('resize', fitCanvas);
window.addEventListener('orientationchange', () => setTimeout(fitCanvas, 300));
