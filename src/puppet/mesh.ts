/**
 * puppet/mesh.ts — パペットワープ用メッシュ (頂点 / 三角形 / ピン) の型と生成
 * 変形対象領域 (レイヤーの不透明ピクセル × 選択範囲) の外接矩形をグリッドで覆い、
 * 領域の輪郭サンプル点も加えて Delaunay 三角分割することで、外形に沿ったメッシュを構築する。
 * canvas に依存しない純粋ロジック (領域判定は関数で受け取る) のため単体検証が容易。
 */
import { DOC_H, DOC_W, type Pt } from "../core/types";
import { triangulate } from "./delaunay";

/** 制御点 (ピン)。original = 打った初期位置、current = 現在の移動先 */
export interface PuppetPin {
  id: number;
  original: Pt;
  current: Pt;
  /** 固定ピン (ドラッグで動かせない)。未移動のピンは自動的にアンカーとして働く */
  isPinned: boolean;
}

/** メッシュの三角形 (vertices 配列への頂点インデックス参照) */
export interface PuppetTriangle {
  indices: [number, number, number];
}

/** パペットワープのメッシュ (vertices / triangles / pins) */
export interface PuppetMesh {
  vertices: Pt[];
  triangles: PuppetTriangle[];
  pins: PuppetPin[];
}

/** 変形対象領域の判定 (ピクセル座標 → 領域内かどうか) */
export type MeshRegion = (x: number, y: number) => boolean;

export interface MeshBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 領域の外接矩形を求める。領域が空なら null */
export function regionBounds(contains: MeshRegion): MeshBounds | null {
  let x0 = DOC_W, y0 = DOC_H, x1 = -1, y1 = -1;
  for (let y = 0; y < DOC_H; y++) {
    for (let x = 0; x < DOC_W; x++) {
      if (!contains(x, y)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < x0 ? null : { x0, y0, x1, y1 };
}

/**
 * メッシュを生成する:
 *   外接矩形の四隅 + spacing 刻みのグリッド頂点 + 領域輪郭のサンプル点
 * を Delaunay 三角分割する。領域が空 (または三角形が作れない) なら null を返す。
 */
export function buildMesh(contains: MeshRegion, spacing: number): PuppetMesh | null {
  const bounds = regionBounds(contains);
  if (!bounds) return null;
  const step = Math.max(8, spacing);

  const points: Pt[] = [];
  const seen = new Set<number>();
  // 0.5px 量子化キーで重複点を排除 (Delaunay は重複点に弱いため)
  const keyOf = (x: number, y: number): number => Math.round(y * 2) * (DOC_W * 2 + 4) + Math.round(x * 2);
  const addPoint = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x > DOC_W || y > DOC_H) return;
    const k = keyOf(x, y);
    if (seen.has(k)) return;
    seen.add(k);
    points.push({ x, y });
  };

  // 外接矩形の四隅
  addPoint(bounds.x0, bounds.y0);
  addPoint(bounds.x1, bounds.y0);
  addPoint(bounds.x0, bounds.y1);
  addPoint(bounds.x1, bounds.y1);

  // グリッド頂点 (外接矩形を spacing 刻みで覆う)
  for (let y = bounds.y0; y <= bounds.y1 + step; y += step) {
    for (let x = bounds.x0; x <= bounds.x1 + step; x += step) {
      addPoint(x, y);
    }
  }

  // 輪郭サンプル点 (境界ピクセルを一定間隔で拾い、外形に沿ったメッシュにする)
  let lastX = -step;
  let lastY = -step;
  const gap2 = step * 0.6 * (step * 0.6);
  for (let y = Math.max(0, bounds.y0 - 1); y <= Math.min(DOC_H - 1, bounds.y1 + 1); y++) {
    for (let x = Math.max(0, bounds.x0 - 1); x <= Math.min(DOC_W - 1, bounds.x1 + 1); x++) {
      if (!contains(x, y)) continue;
      const edge = !contains(x - 1, y) || !contains(x + 1, y) || !contains(x, y - 1) || !contains(x, y + 1);
      if (!edge) continue;
      const dx = x - lastX;
      const dy = y - lastY;
      if (dx * dx + dy * dy < gap2) continue;
      addPoint(x, y);
      lastX = x;
      lastY = y;
    }
  }

  const indices = triangulate(points);
  if (indices.length === 0) return null;
  return {
    vertices: points,
    triangles: indices.map((t) => ({ indices: t })),
    pins: [],
  };
}

/**
 * 変形後空間 (画面上) の点を、初期 (変形前) 空間の対応点へ逆変換する。
 * pos を含む変形後三角形 (deformed) の重心座標を初期頂点 (vertices) へ適用する。
 * どの三角形にも含まれない (メッシュ外) 場合は pos と同じ座標を返す。
 * 変形済みの状態でピンを打つとき、「見た目の位置」を初期空間の座標へ写すために使う。
 */
export function inverseDeformPoint(mesh: PuppetMesh, deformed: readonly Pt[], pos: Pt): Pt {
  for (const { indices } of mesh.triangles) {
    const [i0, i1, i2] = indices;
    const a = deformed[i0];
    const b = deformed[i1];
    const c = deformed[i2];
    const den = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(den) < 1e-9) continue; // 退化三角形
    const l0 = ((b.y - c.y) * (pos.x - c.x) + (c.x - b.x) * (pos.y - c.y)) / den;
    const l1 = ((c.y - a.y) * (pos.x - c.x) + (a.x - c.x) * (pos.y - c.y)) / den;
    const l2 = 1 - l0 - l1;
    if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue; // 三角形の外
    const v = mesh.vertices;
    return {
      x: l0 * v[i0].x + l1 * v[i1].x + l2 * v[i2].x,
      y: l0 * v[i0].y + l1 * v[i1].y + l2 * v[i2].y,
    };
  }
  return { x: pos.x, y: pos.y };
}
