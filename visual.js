// ════════════════════════════════════════════════════════════════════
//  visual.js — レンダーループ・描画
//  依存: camera.js, paths.js, audio.js（すべてグローバル変数として利用）
// ════════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────
//  drawScene — 1フレーム分の描画
// ────────────────────────────────────────────
function drawScene() {
  const W = canvas.width, H = canvas.height;

  // ① カメラ映像を描画（前面カメラは左右反転）
  ctx.clearRect(0, 0, W, H);
  if (currentFacing === 'user') {
    ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, W, H);
    ctx.restore();
  } else {
    ctx.drawImage(video, 0, 0, W, H);
  }

  // ② モーション検出
  pCtx.drawImage(video, 0, 0, PROC_W, PROC_H);
  const frame = pCtx.getImageData(0, 0, PROC_W, PROC_H);
  const gray  = toGray(frame.data);

  if (prevGray) {
    const motion   = detectMotion(gray, prevGray);
    const rawVerts = extractVertices(motion, PROC_W, PROC_H);

    // 処理座標 → 表示座標へスケール変換
    const sx = W / PROC_W, sy = H / PROC_H;
    const mapped = rawVerts.map(([x, y]) =>
      currentFacing === 'user'
        ? [(PROC_W - 1 - x) * sx, y * sy]  // 前面カメラ: X反転
        : [x * sx, y * sy]
    );

    // ③ パス追跡・音楽更新
    processPaths(mapped, W, H);
    updateAudio(verts);

    // ④ VF（ビジュアルフィードバック）減衰
    vfKick   = Math.max(0, vfKick   - 0.10);
    vfHat    = Math.max(0, vfHat    - 0.14);
    vfGuitar = Math.max(0, vfGuitar - 0.03);

    // ⑤ Guitar afterglow（緑の発光）
    if (vfGuitar > 0.04) {
      verts.forEach(([x, y]) => {
        const r   = 18 + vfGuitar * 32;
        const grd = ctx.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, `rgba(140,255,170,${(vfGuitar * 0.14).toFixed(3)})`);
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grd;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      });
    }

    // ⑥ Lines — 線幅を音量と連動（呼吸するように変化）
    //    vol=0 → 0.4px（細）  vol=1 → 6px（太）  kick → 瞬間パルス
    const lines = connectLines(verts).slice(0, 25);
    lines.forEach(([a, b]) => {
      const slotA = (a[4] ?? 0) % MAX_PATHS;
      const slotB = (b[4] ?? 0) % MAX_PATHS;
      const vol   = toneReady
        ? ((pathActVol[slotA] ?? 0) + (pathActVol[slotB] ?? 0)) * 0.5
        : 0;
      ctx.lineWidth   = 0.4 + vol * 5.6 + vfKick * 1.8;
      ctx.strokeStyle = `rgba(200,200,200,${(0.22 + vol * 0.58 + vfKick * 0.20).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    });

    // ⑦ Hat sparks（マイクロパーティクル）
    if (vfHat > 0.06) {
      verts.forEach(([x, y]) => {
        for (let s = 0; s < 4; s++) {
          if (Math.random() > vfHat) continue;
          const px = x + (Math.random() - 0.5) * 30 * vfHat;
          const py = y + (Math.random() - 0.5) * 30 * vfHat;
          ctx.fillStyle = `rgba(255,255,200,${(vfHat * 0.50).toFixed(3)})`;
          ctx.fillRect(px - 1, py - 1, 2, 2);
        }
      });
    }

    // ⑧ Vertex nodes — サイズ・輝度を音量と連動（呼吸するように変化）
    //    vol=0 → 2px  vol=1 → 11px  kick → 瞬間拡大
    ctx.lineWidth = 1;
    verts.forEach(([x, y, , , noteIdx]) => {
      const note  = PATH_NOTES[(noteIdx ?? 0) % MAX_PATHS];
      const slot  = (noteIdx ?? 0) % MAX_PATHS;
      const vol   = toneReady ? (pathActVol[slot] ?? 0) : 0;
      const sz    = 2.0 + vol * 9.0 + vfKick * 3.0;
      const alpha = Math.min(1, 0.35 + vol * 0.60 + vfKick * 0.05);
      const col   = `rgba(215,215,215,${alpha.toFixed(3)})`;

      // 発音グロウ
      if (vol > 0.08) {
        const r   = 16 + vol * 34 + vfKick * 14;
        const grd = ctx.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, `rgba(215,215,215,${(vol * 0.20).toFixed(3)})`);
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grd;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }

      ctx.strokeStyle = col;
      ctx.fillStyle   = col;
      ctx.strokeRect(x - sz, y - sz, sz * 2, sz * 2);
      ctx.fillRect(x - sz * 0.5, y - sz * 0.5, sz, sz);

      // ノート名ラベル（音量が上がるほど大きく）
      ctx.font = vol > 0.25
        ? `bold ${Math.round(9 + vol * 4)}px "Helvetica Neue",monospace`
        : `9px "Helvetica Neue",monospace`;
      ctx.fillStyle = col;
      ctx.fillText(note, x + sz + 4, y + 4);
    });
  }

  prevGray = gray;
}

// ────────────────────────────────────────────
//  loop — RAF ループ（ui.js から起動）
// ────────────────────────────────────────────
function loop() {
  requestAnimationFrame(loop);
  if (++frameTick % FRAME_SKIP !== 0) return;
  drawScene();
}
