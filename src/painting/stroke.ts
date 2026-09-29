/**
 * painting/stroke.ts — ストローク描画の共通処理
 * ブラシ / 消しゴム / 図形の線描画と、選択範囲での切り抜き合成を担う。
 */
import { state } from "../core/editorState";
import { selection } from "../core/selectionStore";

export function drawLineSeg(ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

export function setupStrokeStyle(ctx: CanvasRenderingContext2D): void {
  ctx.globalAlpha = state.opacity / 100;
  if (state.tool === "eraser") ctx.globalCompositeOperation = "destination-out";
  ctx.strokeStyle = state.fg;
  ctx.fillStyle = state.fg;
  ctx.lineWidth = state.brushSize;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

/* ============ 選択範囲クリップ描画 (選択中はその範囲のみ描画) ============ */
/** ストロークを選択範囲で切り抜くための作業canvas (GC負荷軽減のため再利用) */
const strokeTmp = document.createElement("canvas");
export const strokeTmpCtx = strokeTmp.getContext("2d")!;

export function ensureStrokeTmp(w: number, h: number): void {
  if (strokeTmp.width !== w || strokeTmp.height !== h) {
    strokeTmp.width = w;
    strokeTmp.height = h;
  } else {
    strokeTmpCtx.clearRect(0, 0, w, h);
  }
}

/**
 * レイヤーへストロークを合成する。
 * 選択範囲がなければ従来どおり直接描画し、あれば
 * 「作業canvasに不透明でストロークを描く → selection.mask で切り抜き → 不透明度を効かせてレイヤーへ合成」
 * の順で処理することで、選択範囲の外側には一切描画されない。
 * draw: 実際の描画処理。(x0,y0)-(x1,y1) はストロークbbox (doc座標)、pad は線幅等のマージン。
 */
export function paintStroke(
  ctx: CanvasRenderingContext2D,
  draw: (g: CanvasRenderingContext2D) => void,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  pad: number,
): void {
  if (!selection.hasSelection) {
    ctx.save();
    setupStrokeStyle(ctx);
    draw(ctx);
    ctx.restore();
    return;
  }
  const bx = Math.max(0, Math.floor(Math.min(x0, x1) - pad));
  const by = Math.max(0, Math.floor(Math.min(y0, y1) - pad));
  // 対象レイヤー (ctx) の実寸を境界にする (ドキュメントは可変)
  const br = Math.min(ctx.canvas.width, Math.ceil(Math.max(x0, x1) + pad));
  const bb = Math.min(ctx.canvas.height, Math.ceil(Math.max(y0, y1) + pad));
  const bw = br - bx;
  const bh = bb - by;
  if (bw <= 0 || bh <= 0) return;
  ensureStrokeTmp(bw, bh);
  const tg = strokeTmpCtx;
  // 1) ストロークを不透明で描画 (消しゴムも作業canvas上では通常描画)
  tg.save();
  tg.translate(-bx, -by);
  setupStrokeStyle(tg);
  tg.globalAlpha = 1;
  tg.globalCompositeOperation = "source-over";
  draw(tg);
  tg.restore();
  // 2) 選択マスクで切り抜く
  tg.save();
  tg.globalCompositeOperation = "destination-in";
  tg.drawImage(selection.mask, -bx, -by);
  tg.restore();
  // 3) レイヤーへ合成 (不透明度はここで一度だけ効く。消しゴムは destination-out)
  ctx.save();
  ctx.globalAlpha = state.opacity / 100;
  if (state.tool === "eraser") ctx.globalCompositeOperation = "destination-out";
  ctx.drawImage(strokeTmp, bx, by);
  ctx.restore();
}

/** フィルターペンなど、作業canvasを直接使う処理向けに公開 */
export function getStrokeTmp(): HTMLCanvasElement {
  return strokeTmp;
}