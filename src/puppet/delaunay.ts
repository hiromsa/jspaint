/**
 * puppet/delaunay.ts — Bowyer-Watson 法による Delaunay 三角分割 (外部依存ゼロ)
 * 頂点数は数百規模を想定しており、素朴な逐次挿入実装で十分高速 (セッション開始時の 1 回のみ実行)。
 * 重複点があると退化するため、呼び出し側 (mesh.ts) で重複を除去しておくこと。
 */
import type { Pt } from "../core/types";

/** 三角形 (頂点配列へのインデックス 3 個組) */
export type TriIndices = [number, number, number];

/** 外接円をキャッシュした三角形 (点挿入の外接円判定を高速化するため) */
interface CircumTri {
  a: number;
  b: number;
  c: number;
  cx: number;
  cy: number;
  r2: number;
}

/** 3 頂点の外接円を求める。3 点がほぼ同一直線上 (退化) の場合は null */
function circumcircle(pts: readonly Pt[], a: number, b: number, c: number): CircumTri | null {
  const ax = pts[a].x, ay = pts[a].y;
  const bx = pts[b].x, by = pts[b].y;
  const cx = pts[c].x, cy = pts[c].y;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-10) return null;
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  const dx = ax - ux;
  const dy = ay - uy;
  return { a, b, c, cx: ux, cy: uy, r2: dx * dx + dy * dy };
}

/** 点群を Delaunay 三角分割する (スーパートライアングルを含む三角形は除外済み) */
export function triangulate(points: readonly Pt[]): TriIndices[] {
  const n = points.length;
  if (n < 3) return [];

  // 点群全体を確実に覆うスーパートライアングル (index n, n+1, n+2) を用意する
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const pts: Pt[] = [
    ...points,
    { x: midX - 20 * span, y: midY - span },
    { x: midX, y: midY + 20 * span },
    { x: midX + 20 * span, y: midY - span },
  ];

  let tris: CircumTri[] = [];
  const first = circumcircle(pts, n, n + 1, n + 2);
  if (!first) return [];
  tris.push(first);

  for (let i = 0; i < n; i++) {
    const px = points[i].x;
    const py = points[i].y;
    // 挿入点の外接円に含まれる三角形 (bad) とそうでない三角形 (keep) を分ける
    const bad: CircumTri[] = [];
    const keep: CircumTri[] = [];
    for (const t of tris) {
      const dx = px - t.cx;
      const dy = py - t.cy;
      if (dx * dx + dy * dy <= t.r2) bad.push(t);
      else keep.push(t);
    }
    // bad 三角形群の境界エッジ (1 度だけ現れる辺) を抽出し、挿入点と再分割する
    const edges: [number, number][] = [];
    for (const t of bad) {
      const sides: [number, number][] = [[t.a, t.b], [t.b, t.c], [t.c, t.a]];
      for (const side of sides) {
        const [p0, p1] = side;
        let shared = -1;
        for (let j = 0; j < edges.length; j++) {
          const [q0, q1] = edges[j];
          if ((q0 === p0 && q1 === p1) || (q0 === p1 && q1 === p0)) { shared = j; break; }
        }
        if (shared >= 0) edges.splice(shared, 1);
        else edges.push(side);
      }
    }
    tris = keep;
    for (const [p0, p1] of edges) {
      const t = circumcircle(pts, p0, p1, i);
      if (t) tris.push(t);
    }
  }

  // スーパートライアングルの頂点を含む三角形を取り除く
  const result: TriIndices[] = [];
  for (const t of tris) {
    if (t.a < n && t.b < n && t.c < n) result.push([t.a, t.b, t.c]);
  }
  return result;
}
