/**
 * puppet/warpPaint.ts — 変形メッシュに沿って元画像を転写する描画
 * 各三角形を「クリップ + アフィン変換 (ctx.transform)」でオフスクリーン canvas へ描く。
 * クリップパスをわずかに膨らませて隣接三角形との継ぎ目 (シーム) を消す。
 */
import { createCanvas } from "../core/canvasUtils";
import type { Pt } from "../core/types";
import type { PuppetMesh } from "./mesh";

/** 三角形クリップの膨張量 (px)。隣接三角形との隙間 (ギャップアーティファクト)対策 */
const SEAM_PAD = 0.5;

/**
 * src 三角形を dst 三角形へ写すアフィン変換を 3 点対応から解き、
 * source をクリック + transform で描画する。
 * dst = M·src となる 2x3 行列 (a,b,c,d,e,f) を Cramer の公式で直接解く。
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
  g.drawImage(source, 0, 0);
  g.restore();
}

/**
 * 変形後メッシュに沿って source 全体を転写した canvas を生成する。
 * deformed は computeDeformedVertices() の結果 (vertices と同順)。
 */
export function renderWarped(
  source: HTMLCanvasElement,
  mesh: PuppetMesh,
  deformed: readonly Pt[],
): HTMLCanvasElement {
  const out = createCanvas();
  const g = out.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  for (const { indices } of mesh.triangles) {
    const [i0, i1, i2] = indices;
    drawTransformedTriangle(
      g,
      source,
      [mesh.vertices[i0], mesh.vertices[i1], mesh.vertices[i2]],
      [deformed[i0], deformed[i1], deformed[i2]],
    );
  }
  return out;
}
