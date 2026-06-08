// ════════════════════════════════════════════════════════════════════
//  paths.js — モーション検出・頂点追跡
//  依存: camera.js（isMobile, canvas）
// ════════════════════════════════════════════════════════════════════

// ── モーション検出状態 ──
let prevGray    = null;
let smoothDens  = null;
let bgModel     = null;

// ── 頂点状態 ──
// stableVerts[i] = [x, y, timestamp, vx, vy, noteIdx, initY, playing]
let stableVerts  = [];
let verts        = [];   // レンダー用: [x, y, vx, vy, noteIdx, initY, playing]
let nextNoteIdx  = 0;

// ────────────────────────────────────────────
//  グレースケール変換
// ────────────────────────────────────────────
function toGray(data) {
  const g = new Uint8ClampedArray(data.length / 4);
  for (let i = 0, j = 0; i < data.length; i += 4, j++)
    g[j] = (data[i] + data[i + 1] + data[i + 2]) / 3;
  return g;
}

// ────────────────────────────────────────────
//  背景差分 + フレーム差分 AND ゲート
//  静止背景を学習し、真に動いている物体のみ抽出
// ────────────────────────────────────────────
function detectMotion(gray, prev) {
  if (!bgModel) { bgModel = new Float32Array(gray.length); bgModel.set(gray); }
  const m      = new Float32Array(gray.length);
  const THRESH = 20;    // ノイズ除去閾値
  const BG_A   = 0.04;  // 背景モデル更新速度
  for (let i = 0; i < gray.length; i++) {
    const fd = Math.abs(gray[i] - prev[i]);       // フレーム差分
    const bd = Math.abs(gray[i] - bgModel[i]);    // 背景差分
    m[i] = (fd > THRESH && bd > THRESH) ? (fd + bd) * 0.5 : 0;
    if (fd < THRESH) bgModel[i] += (gray[i] - bgModel[i]) * BG_A;
  }
  return m;
}

// ────────────────────────────────────────────
//  モーション密度からローカル極大点を抽出 → 頂点候補
// ────────────────────────────────────────────
function extractVertices(motion, w, h) {
  const GRID = 6, RAD = 10, MIN_DENS = 520, DECAY = 0.72;
  const gw   = Math.floor((w - RAD * 2) / GRID);
  const gh   = Math.floor((h - RAD * 2) / GRID);

  if (!smoothDens || smoothDens.length !== gw * gh)
    smoothDens = new Float32Array(gw * gh);

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const cx = RAD + gx * GRID, cy = RAD + gy * GRID;
      let sum = 0;
      for (let dy = -RAD; dy <= RAD; dy += 2)
        for (let dx = -RAD; dx <= RAD; dx += 2)
          sum += motion[(cy + dy) * w + (cx + dx)];
      smoothDens[gy * gw + gx] = smoothDens[gy * gw + gx] * DECAY + sum * (1 - DECAY);
    }
  }

  const pts = [];
  for (let gy = 1; gy < gh - 1; gy++) {
    for (let gx = 1; gx < gw - 1; gx++) {
      const d = smoothDens[gy * gw + gx];
      if (d < MIN_DENS) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++)
        for (let dx = -1; dx <= 1 && isMax; dx++) {
          if (dy === 0 && dx === 0) continue;
          if (smoothDens[(gy + dy) * gw + (gx + dx)] > d) isMax = false;
        }
      if (isMax) pts.push([RAD + gx * GRID, RAD + gy * GRID]);
    }
  }
  return pts;
}

// ────────────────────────────────────────────
//  最近傍3点接続（三角形ネットワーク）
// ────────────────────────────────────────────
function connectLines(pts) {
  const MAX  = isMobile ? 30 : 80;
  const src  = pts.length > MAX ? pts.slice(0, MAX) : pts;
  const lines = [];
  for (let i = 0; i < src.length; i++) {
    const ds = [];
    for (let j = 0; j < src.length; j++) {
      if (i === j) continue;
      const dx = src[j][0] - src[i][0], dy = src[j][1] - src[i][1];
      ds.push({ index: j, dist: dx * dx + dy * dy });
    }
    ds.sort((a, b) => a.dist - b.dist);
    for (let k = 0; k < 3 && ds[k]; k++) lines.push([src[i], src[ds[k].index]]);
  }
  return lines;
}

// ────────────────────────────────────────────
//  マッピング済み頂点 → stableVerts 更新 → verts 生成
//
//  stableVerts は「パスの持続的なアイデンティティ」を保持する
//  新頂点には Dm7 ノートを順番に割り当て (MAX_PATHS スロット)
//  2秒以上検出されない頂点は自然消滅（Gain は audio.js が自動フェードアウト）
// ────────────────────────────────────────────
function processPaths(mapped, W, H) {
  const MERGE_DIST2 = (W * 0.12) ** 2;
  const now = Date.now();

  for (const nv of mapped) {
    let merged = false;
    for (let i = 0; i < stableVerts.length; i++) {
      const dx = stableVerts[i][0] - nv[0], dy = stableVerts[i][1] - nv[1];
      if (dx * dx + dy * dy < MERGE_DIST2) {
        // 既存頂点とマージ: 速度を更新、音楽メタデータ [5][6][7] は保持
        const vx = nv[0] - stableVerts[i][0], vy = nv[1] - stableVerts[i][1];
        stableVerts[i] = [
          nv[0], nv[1], now, vx, vy,
          stableVerts[i][5],  // noteIdx
          stableVerts[i][6],  // initY
          stableVerts[i][7],  // playing
        ];
        merged = true;
        break;
      }
    }
    if (!merged) {
      // 新頂点: ノートスロットを循環割り当て
      const ni = (nextNoteIdx++) % MAX_PATHS;
      stableVerts.push([nv[0], nv[1], now, 0, 0, ni, nv[1], false]);
      // スロット上限超過時は最古の頂点を押し出す
      if (stableVerts.length > MAX_PATHS) stableVerts.shift();
    }
  }

  // 2秒以上未検出の頂点を削除（Gain フェードは audio.js が担当）
  stableVerts = stableVerts.filter(v => now - v[2] < 2000);

  // レンダー用の簡略配列を生成
  verts = stableVerts.map(v => [
    v[0], v[1],
    v[3] ?? 0, v[4] ?? 0,  // vx, vy
    v[5] ?? 0,              // noteIdx
    v[6] ?? v[1],           // initY
    v[7] ?? false,          // playing
  ]);
}
