import type { Pt } from "../core/types";

/**
 * rendering/triangleTransfer.ts — src 三角形 → dst 三角形 のアフィン転写 (パペットワープ / メッシュワープ共用)
 * クリップパスをわずかに膨らませて隣接三角形との継ぎ目 (シーム) を消す。
 */

/** 三角形クリップの膨張量 (px)。隣接三角形との隙間 (ギャップアーティファクト)対策 */
const SEAM_PAD = 0.5;

/**
 * アフィン変換 (dst = M·src + 平行移動) の逆変換で dst 矩形を src 矩形へ写す。
 * 三角形の転写に必要なソース領域を求めるために使う。行列が特異の場合は null。
 */
function inverseTransformRect(
  a: number, b: number, c: number, d: number, e: number, f: number,
  dx0: number, dy0: number, dx1: number, dy1: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-8) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [px, py] of [[dx0, dy0], [dx1, dy0], [dx1, dy1], [dx0, dy1]] as const) {
    const rx = px - e;
    const ry = py - f;
    const ix = (d * rx - c * ry) / det;
    const iy = (a * ry - b * rx) / det;
    x0 = Math.min(x0, ix);
    y0 = Math.min(y0, iy);
    x1 = Math.max(x1, ix);
    y1 = Math.max(y1, iy);
  }
  return { x0, y0, x1, y1 };
}

/**
 * src 三角形を dst 三角形へ写すアフィン変換を 3 点対応から解き、
 * source をクリック + transform で描画する。
 * dst = M·src となる 2x3 行列 (a,b,c,d,e,f) を Cramer の公式で直接解く。
 * 転写範囲は dst 三角形の外接矩形 (+パッド) に対応するソース領域に限定し、
 * フルサイズ drawImage のオーバードローを避ける。
 */
export function drawTransformedTriangle(
  g: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  src: readonly [Pt, Pt, Pt],
  dst: readonly [Pt, Pt, Pt],
): void {
  const [s0, s1, s2] = src;
  const [d0, d1, d2] = dst;
  const det = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(det) < 1e-8) return; // 退化三角形 (面積ほぼ 0) は描画しない
  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / det;
  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / det;
  const c = (s0.x * (d1.x - d2.x) - d0.x * (s1.x - s2.x) + (s1.x * d2.x - s2.x * d1.x)) / det;
  const d = (s0.x * (d1.y - d2.y) - d0.y * (s1.x - s2.x) + (s1.x * d2.y - s2.x * d1.y)) / det;
  const e = (s0.x * (s1.y * d2.x - s2.y * d1.x) - s0.y * (s1.x * d2.x - s2.x * d1.x) + d0.x * (s1.x * s2.y - s2.x * s1.y)) / det;
  const f = (s0.x * (s1.y * d2.y - s2.y * d1.y) - s0.y * (s1.x * d2.y - s2.x * d1.y) + d0.y * (s1.x * s2.y - s2.x * s1.y)) / det;

  g.save();
  // クリップパス (重心から SEAM_PAD px 外側へ膨らませてシームを消す)
  const gx = (d0.x + d1.x + d2.x) / 3;
  const gy = (d0.y + d1.y + d2.y) / 3;
  g.beginPath();
  [d0, d1, d2].forEach((p, i) => {
    const dx = p.x - gx;
    const dy = p.y - gy;
    const k = 1 + SEAM_PAD / (Math.hypot(dx, dy) || 1);
    const x = gx + dx * k;
    const y = gy + dy * k;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  });
  g.closePath();
  g.clip();
  g.transform(a, b, c, d, e, f);
  // dst 外接矩形 (クリップの膨張分 + 余白) を逆変換し、必要なソース領域だけ転写する
  const pad = SEAM_PAD + 1;
  const region = inverseTransformRect(
    a, b, c, d, e, f,
    Math.min(d0.x, d1.x, d2.x) - pad,
    Math.min(d0.y, d1.y, d2.y) - pad,
    Math.max(d0.x, d1.x, d2.x) + pad,
    Math.max(d0.y, d1.y, d2.y) + pad,
  );
  if (region) {
    // floor/ceil ±1px で端のサンプリング余白を確保してソース範囲へクランプ
    const sx0 = Math.max(0, Math.floor(region.x0) - 1);
    const sy0 = Math.max(0, Math.floor(region.y0) - 1);
    const sx1 = Math.min(source.width, Math.ceil(region.x1) + 1);
    const sy1 = Math.min(source.height, Math.ceil(region.y1) + 1);
    const sw = sx1 - sx0;
    const sh = sy1 - sy0;
    if (sw > 0 && sh > 0) g.drawImage(source, sx0, sy0, sw, sh, sx0, sy0, sw, sh);
  }
  g.restore();
}
