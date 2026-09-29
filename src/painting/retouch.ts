/**
 * painting/retouch.ts — レタッチツール (指先 / 覆い焼き / 焼き込み)
 * 編集対象レイヤーのピクセルに直接作用するスタンプ系処理。
 */
import { state } from "../core/editorState";
import { selection } from "../core/selectionStore";
import type { Layer, Pt } from "../core/types";

/* --- 円形フォールオフ (覆い焼き / 焼き込み / 膨張の共通) --- */
/** 円形フォールオフ: t = 0 (中心) → 1 (エッジ)。中心55%は全強度、外周へ cos フェード */
export function toneFalloff(t: number): number {
  return t <= 0.55 ? 1 : 0.5 * (1 + Math.cos(((t - 0.55) / 0.45) * Math.PI));
}

/* --- 指先 (スマッジ) --- */
const stampBuf = document.createElement("canvas");
const stampCtx = stampBuf.getContext("2d")!;
let stampBufSize = 0;

function ensureStampBuf(size: number): void {
  if (stampBufSize === size) return;
  stampBuf.width = size;
  stampBuf.height = size;
  stampBufSize = size;
}

/** from 周辺の対象レイヤー画像を円形ソフトマスクで切り出し、to へ引きずってスタンプ */
export function smudgeStamp(target: Layer, from: Pt, to: Pt): void {
  const size = Math.max(2, Math.round(state.brushSize));
  const r = size / 2;
  ensureStampBuf(size);
  const g = stampCtx;
  g.clearRect(0, 0, size, size);
  // 円形ソフトマスク (中心〜55%は不透明、外周へ滑らかにフェード)
  const grad = g.createRadialGradient(r, r, r * 0.55, r, r, r);
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.beginPath();
  g.arc(r, r, r, 0, Math.PI * 2);
  g.fill();
  // from 周辺の対象レイヤー画像をマスクで切り出す (ソース矩形はドキュメント内にクランプ)
  const sx = from.x - r;
  const sy = from.y - r;
  const cx0 = Math.max(0, Math.floor(sx));
  const cy0 = Math.max(0, Math.floor(sy));
  const cx1 = Math.min(target.canvas.width, Math.ceil(sx + size));
  const cy1 = Math.min(target.canvas.height, Math.ceil(sy + size));
  if (cx1 > cx0 && cy1 > cy0) {
    g.globalCompositeOperation = "source-in";
    g.drawImage(target.canvas, cx0, cy0, cx1 - cx0, cy1 - cy0, cx0 - sx, cy0 - sy, cx1 - cx0, cy1 - cy0);
    g.globalCompositeOperation = "source-over";
  }
  if (selection.hasSelection) {
    // 選択範囲がある場合はスタンプを選択マスクで切り抜き、外側に効果が出ないようにする
    g.globalCompositeOperation = "destination-in";
    g.drawImage(selection.mask, Math.round(to.x - r), Math.round(to.y - r), size, size, 0, 0, size, size);
    g.globalCompositeOperation = "source-over";
  }
  const ctx = target.ctx;
  ctx.save();
  ctx.globalAlpha = Math.min(1, (state.opacity / 100) * 0.85);
  ctx.drawImage(stampBuf, Math.round(to.x - r), Math.round(to.y - r));
  ctx.restore();
}

/* --- 覆い焼き / 焼き込み --- */

/** Alt キーで覆い焼き ⇔ 焼き込みを反転 */
export function toneMode(alt: boolean): "dodge" | "burn" {
  const t = state.tool === "burn" ? "burn" : "dodge";
  return alt ? (t === "dodge" ? "burn" : "dodge") : t;
}

/** at を中心に、円形フォールオフで対象レイヤーの輝度を加減算する */
export function toneStamp(target: Layer, mode: "dodge" | "burn", at: Pt): void {
  const size = Math.ceil(state.brushSize);
  const r = state.brushSize / 2;
  const x0 = Math.floor(at.x - r);
  const y0 = Math.floor(at.y - r);
  const sx = Math.max(0, x0);
  const sy = Math.max(0, y0);
  const ex = Math.min(target.canvas.width, x0 + size + 1);
  const ey = Math.min(target.canvas.height, y0 + size + 1);
  if (ex <= sx || ey <= sy) return;
  const ctx = target.ctx;
  const img = ctx.getImageData(sx, sy, ex - sx, ey - sy);
  const d = img.data;
  const w = ex - sx;
  const h = ey - sy;
  const cx = at.x - sx;
  const cy = at.y - sy;
  const kBase = (state.opacity / 100) * 0.4;
  // 選択範囲がある場合は選択マスクのアルファで効果を減衰 (0 = 完全に効果なし)
  const selD = selection.hasSelection ? selection.ctx.getImageData(sx, sy, w, h).data : null;
  for (let y = 0; y < h; y++) {
    const dy = y + 0.5 - cy;
    const dy2 = dy * dy;
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx;
      const t = Math.sqrt(dx * dx + dy2) / r;
      if (t >= 1) continue;
      const m = toneFalloff(t);
      if (m <= 0.004) continue;
      const i = (y * w + x) * 4;
      let k = kBase * m;
      if (selD) {
        const sa = selD[i + 3] / 255;
        if (sa <= 0) continue;
        k *= sa;
      }
      if (mode === "dodge") {
        d[i] += (255 - d[i]) * k;
        d[i + 1] += (255 - d[i + 1]) * k;
        d[i + 2] += (255 - d[i + 2]) * k;
      } else {
        d[i] -= d[i] * k;
        d[i + 1] -= d[i + 1] * k;
        d[i + 2] -= d[i + 2] * k;
      }
    }
  }
  ctx.putImageData(img, sx, sy);
}

/** ストロークをブラシ幅の 1/4 間隔で補間しながらスタンプを並べる */
export function retouchStroke(
  stamp: (from: Pt, to: Pt) => void,
  from: Pt,
  to: Pt,
): void {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const step = Math.max(1, state.brushSize * 0.25);
  const n = Math.max(1, Math.ceil(dist / step));
  let prev = from;
  for (let i = 1; i <= n; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n };
    stamp(prev, p);
    prev = p;
  }
}