/**
 * puppet/warpPaint.ts — 変形メッシュに沿って元画像を転写する描画
 * 各三角形を「クリップ + アフィン変換」でオフスクリーン canvas へ描く。
 * 転写本体は rendering/triangleTransfer.ts の共用実装 (メッシュワープと共通)。
 */
import { createCanvas } from "../core/canvasUtils";
import type { Pt } from "../core/types";
import { drawTransformedTriangle } from "../rendering/triangleTransfer";
import type { PuppetMesh } from "./mesh";

/**
 * 変形後メッシュに沿って source 全体を転写した canvas を生成する。
 * deformed は computeDeformedVertices() の結果 (vertices と同順)。
 * quality はドラッグ中に "low" を渡して転写を高速化する用途を想定。
 */
export function renderWarped(
  source: HTMLCanvasElement,
  mesh: PuppetMesh,
  deformed: readonly Pt[],
  quality: ImageSmoothingQuality = "high",
): HTMLCanvasElement {
  const out = createCanvas(source.width, source.height);
  const g = out.getContext("2d")!;
  g.imageSmoothingQuality = quality;
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
