// ════════════════════════════════════════════════════════════════════
//  ui.js — アプリ起動・ジェスチャー・PWA
//  依存: camera.js, audio.js, visual.js（すべて読み込み済み）
// ════════════════════════════════════════════════════════════════════

const startButton = document.getElementById('startButton');

// ────────────────────────────────────────────
//  ダブルタップ → カメラ前後切り替え（UI要素不要）
// ────────────────────────────────────────────
let _lastTap = 0;
canvas.addEventListener('touchend', async (e) => {
  const now2 = Date.now();
  if (now2 - _lastTap < 300) {
    e.preventDefault();
    try {
      await startStream(currentFacing === 'user' ? 'environment' : 'user');
    } catch (err) {}
  }
  _lastTap = now2;
}, { passive: false });

// ────────────────────────────────────────────
//  Wake Lock — 画面消灯防止
// ────────────────────────────────────────────
let wakeLock = null;
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
}

// バックグラウンド復帰時の再取得
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    await resumeAudio();
    if (wakeLock !== null) requestWakeLock();
  }
});

// iOS AudioContext 再開（タッチ/クリックで復帰）
document.addEventListener('touchstart', resumeAudio, { passive: true });
document.addEventListener('click',      resumeAudio, { passive: true });

// ────────────────────────────────────────────
//  startCamera — STARTボタン押下時の起動シーケンス
//  1. Audio 初期化
//  2. カメラ起動（背面優先 → フロントへフォールバック）
//  3. STARTボタン非表示
//  4. WakeLock 取得
//  5. レンダーループ開始
// ────────────────────────────────────────────
async function startCamera() {
  startButton.style.pointerEvents = 'none';
  startButton.style.opacity = '0.4';
  try {
    await initAudio();
    // 背面カメラ（自然風景撮影用）
    try {
      await startStream('environment');
    } catch (e) {
      // 背面カメラなし（デスクトップ等）→ 前面で起動
      await startStream('user');
    }
    startButton.style.display = 'none';
    await requestWakeLock();
    loop();
  } catch (e) {
    startButton.style.pointerEvents = '';
    startButton.style.opacity = '1';
    alert('カメラとマイクの許可が必要です。\nブラウザの設定からカメラを許可してください。');
    console.error(e);
  }
}
startButton.addEventListener('click', startCamera);

// ────────────────────────────────────────────
//  PWA: Service Worker 登録
// ────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./service-worker.js')
      .catch(err => console.warn('SW registration failed:', err));
  });
}
