/**
 * meshwarp/warpPaint.ts — メッシュワープのプレビュー転写
 * 各パッチを u / v 方向の小四角形に分割し、「変形前 (home) → 変形後 (pos)」の
 * 対応三角形でアフィン転写する。転写本体は rendering/triangleTransfer.ts の共用実装。
 * パッチ境界の曲線は分割数に比例して滑らかに追従する。
 */
import { createCanvas } from "../core/canvasUtils";
import type { Pt } from "../core/types";
import { drawTransformedTriangle } from "../rendering/triangleTransfer";
import type { MeshWarpGrid, MwPatch } from "./meshGrid";

/** 1 辺あたりの評価分割数: セグメント数に比例 (細分化されたパッチほど細かく追従) */
function subdivisions(segments: number): number {
  return Math.min(32, Math.max(4, segments * 3));
}

/**
 * メッシュワープのグリッド変形を source 全体へ適用した canvas を生成する。
 * quality はドラッグ中に "low" を渡して転写を高速化する用途を想定。
 */
export function renderWarpedMesh(
  source: HTMLCanvasElement,
  grid: MeshWarpGrid,
  quality: ImageSmoothingQuality = "high",
): HTMLCanvasElement {
  const out = createCanvas(source.width, source.height);
  const g = out.getContext("2d")!;
  g.imageSmoothingQuality = quality;
  for (const patch of grid.patches) {
    transferPatch(g, source, grid, patch);
  }
  return out;
}

/** 1 パッチを u / v グリッドの小三角形で転写する */
function transferPatch(
  g: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  grid: MeshWarpGrid,
  patch: MwPatch,
): void {
  const nu = subdivisions(patch.top.length - 1);
  const nv = subdivisions(patch.left.length - 1);
  // 評価点: H = 変形前 (転写元) / P = 変形後 (転写先)
  const home: Pt[][] = [];
  const pos: Pt[][] = [];
  for (let r = 0; r <= nv; r++) {
    home[r] = [];
    pos[r] = [];
    for (let c = 0; c <= nu; c++) {
      const u = c / nu;
      const v = r / nv;
      home[r][c] = grid.evaluatePatch(patch, u, v, "home");
      pos[r][c] = grid.evaluatePatch(patch, u, v, "pos");
    }
  }
  for (let r = 0; r < nv; r++) {
    for (let c = 0; c < nu; c++) {
      // 四角形 (r,c)-(r,c+1)-(r+1,c+1)-(r+1,c) を 2 三角形で転写
      drawTransformedTriangle(
        g, source,
        [home[r][c], home[r + 1][c], home[r + 1][c + 1]],
        [pos[r][c], pos[r + 1][c], pos[r + 1][c + 1]],
      );
      drawTransformedTriangle(
        g, source,
        [home[r][c], home[r + 1][c + 1], home[r][c + 1]],
        [pos[r][c], pos[r + 1][c + 1], pos[r][c + 1]],
      );
    }
  }
}
