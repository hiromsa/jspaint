/**
 * meshwarp/meshGrid.ts — メッシュワープのグリッド (行 × 列の完全グリッド) とその数理ロジック
 *
 * データ構造 (仕様 2):
 * - Node  : 座標 (home = 変形前 / pos = 変形後) と、隣接方向ごとのベジェハンドル (相対ベクトル)
 * - Edge  : 隣接する 2 つの Node を結ぶ 3 次ベジェ曲線 (行内 = 水平エッジ / 列内 = 垂直エッジ)
 * - Patch : 4 つの Node で囲まれた領域。内部の変形は双三次クーンズパッチ
 *
 * グリッドは「行 × 列」の完全グリッドとして管理するため、ポイント追加 (列 / 行の挿入) は
 * **グリッド全体 (最初の矩形の幅・高さ) に貫通**し、T ジャンクション (不整合な境界) は発生しない。
 * canvas に依存しない純粋ロジックのため単体検証が容易 (npm run test:meshwarp)。
 */
import type { Pt } from "../core/types";

/** 評価空間: home = 変形前 (元画像のサンプリング位置) / pos = 変形後 (表示・編集対象) */
export type MwSpace = "home" | "pos";

/** パッチの辺の識別子 */
export type MwSide = "top" | "right" | "bottom" | "left";

/** 全パッチの辺リスト (走査用) */
export const MW_SIDES: readonly MwSide[] = ["top", "right", "bottom", "left"];

/** ワープの交点 (ポイント)。ハンドルは「隣接ノード ID → 相対ベクトル」で保持 (長さ 0 は保持しない) */
export interface MwNode {
  id: number;
  /** 変形前空間の位置 (転写のソース) */
  home: Pt;
  /** 変形後空間の位置 (表示 / 編集対象) */
  pos: Pt;
  homeHandles: Map<number, Pt>;
  posHandles: Map<number, Pt>;
}

/** 4 つの Node と 4 辺 (chain = 両端を含む Node ID 列。完全グリッドでは常に単一セグメント) */
export interface MwPatch {
  tl: number;
  tr: number;
  br: number;
  bl: number;
  /** top: tl→tr / right: tr→br / bottom: bl→br / left: tl→bl */
  top: number[];
  right: number[];
  bottom: number[];
  left: number[];
}

/** エッジのヒット結果 (エッジ a→b 上のパラメータ t。a→b 向きに正規化) */
export interface MwEdgeHit {
  /** true = 水平エッジ (行内の左右方向) / false = 垂直エッジ (列内の上下方向) */
  horizontal: boolean;
  /** 水平なら行 index / 垂直なら列 index */
  line: number;
  /** 分割対象のセグメント index (水平なら列 index / 垂直なら行 index) */
  segment: number;
  aId: number;
  bId: number;
  t: number;
  distance: number;
}

/** エッジ直接ドラッグの状態 (仕様 4.3: 擬似逆行列によるハンドル分配) */
export interface MwEdgeDrag {
  aId: number;
  bId: number;
  /** ドラッグ開始時の pos ハンドル (相対ベクトル) */
  baseP1: Pt;
  baseP2: Pt;
  /** ドラッグ開始点でのバーンスタイン基底 B1(t) / B2(t) */
  b1: number;
  b2: number;
  /** ドラッグ開始時のマウス位置 (pos 空間) */
  start: Pt;
}

/* ---------- ベクトル / ベジェの純粋ユーティリティ ---------- */

export const addPt = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const subPt = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const mulPt = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
export const lerpPt = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const len2 = (a: Pt): number => a.x * a.x + a.y * a.y;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** 3 次ベジェ曲線の評価 (バーンスタイン多項式による重み付き和) */
export function bezierAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const s = 1 - t;
  const w0 = s * s * s;
  const w1 = 3 * s * s * t;
  const w2 = 3 * s * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
    y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
  };
}

/**
 * ド・カステリョのアルゴリズム (仕様 4.2)。
 * パラメータ t で曲線を 2 分割したときの分割点 C と、
 * 前半 / 後半の第 2 制御点 (新ハンドルの基準) L2 / R2 を返す。
 */
export function deCasteljau(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): { c: Pt; l2: Pt; r2: Pt } {
  const l1 = lerpPt(p0, p1, t);
  const m1 = lerpPt(p1, p2, t);
  const r1 = lerpPt(p2, p3, t);
  const l2 = lerpPt(l1, m1, t);
  const r2 = lerpPt(m1, r1, t);
  const c = lerpPt(l2, r2, t);
  return { c, l2, r2 };
}

/** エッジ直接ドラッグの重み (仕様 4.3): ΔP = ΔD × B / (B1² + B2²) */
export function edgeDragWeights(b1: number, b2: number): { w1: number; w2: number } {
  const n = b1 * b1 + b2 * b2;
  if (n < 1e-12) return { w1: 0, w2: 0 };
  return { w1: b1 / n, w2: b2 / n };
}

/**
 * メッシュワープのグリッド (行 × 列の完全グリッド)。
 * Node (id / home / pos / ハンドル) の行列を管理し、クーンズパッチ評価・
 * 列 / 行の挿入 (ポイント追加)・エッジ操作を提供する。
 */
export class MeshWarpGrid {
  readonly nodes = new Map<number, MwNode>();
  /** ノード ID の行列 ([行][列]) */
  readonly rows: number[][];
  private nextId = 1;

  /** 対象矩形 (右上は排他) を囲む 2×2 ノード・1 パッチの初期グリッドを作る (仕様 3.1) */
  static createRect(x0: number, y0: number, x1: number, y1: number): MeshWarpGrid {
    const grid = new MeshWarpGrid([[], []]);
    grid.rows[0].push(grid.addNode(x0, y0), grid.addNode(x1, y0));
    grid.rows[1].push(grid.addNode(x0, y1), grid.addNode(x1, y1));
    return grid;
  }

  /** ノード行列からグリッドを構築する (テスト / clone 用) */
  constructor(rows: number[][]) {
    this.rows = rows;
  }

  private addNode(x: number, y: number): number {
    const id = this.nextId++;
    this.nodes.set(id, {
      id,
      home: { x, y },
      pos: { x, y },
      homeHandles: new Map(),
      posHandles: new Map(),
    });
    return id;
  }

  get rowCount(): number {
    return this.rows.length;
  }

  get colCount(): number {
    return this.rows[0].length;
  }

  /** 全パッチ (行列から生成)。chain は完全グリッドのため常に単一セグメント */
  get patches(): MwPatch[] {
    const out: MwPatch[] = [];
    for (let r = 0; r < this.rowCount - 1; r++) {
      for (let c = 0; c < this.colCount - 1; c++) {
        const tl = this.rows[r][c];
        const tr = this.rows[r][c + 1];
        const br = this.rows[r + 1][c + 1];
        const bl = this.rows[r + 1][c];
        out.push({ tl, tr, br, bl, top: [tl, tr], right: [tr, br], bottom: [bl, br], left: [tl, bl] });
      }
    }
    return out;
  }

  node(id: number): MwNode {
    return this.nodes.get(id)!;
  }

  /** ノードの位置 (評価空間ごと) */
  nodePos(id: number, space: MwSpace): Pt {
    const n = this.node(id);
    return space === "home" ? n.home : n.pos;
  }

  /** 全ノードが初期位置・全ハンドルが未編集 (恒等変形) なら true */
  isIdentity(): boolean {
    for (const n of this.nodes.values()) {
      if (Math.abs(n.pos.x - n.home.x) > 1e-9 || Math.abs(n.pos.y - n.home.y) > 1e-9) return false;
      for (const h of n.homeHandles.values()) if (len2(h) > 1e-18) return false;
      for (const h of n.posHandles.values()) if (len2(h) > 1e-18) return false;
    }
    return true;
  }

  /** グリッド全体のディープコピー (セッション内 Undo 用) */
  clone(): MeshWarpGrid {
    const copy = new MeshWarpGrid(this.rows.map((row) => [...row]));
    (copy as unknown as { nextId: number }).nextId = this.nextId;
    for (const n of this.nodes.values()) {
      copy.nodes.set(n.id, {
        id: n.id,
        home: { ...n.home },
        pos: { ...n.pos },
        homeHandles: new Map([...n.homeHandles].map(([k, v]) => [k, { ...v }])),
        posHandles: new Map([...n.posHandles].map(([k, v]) => [k, { ...v }])),
      });
    }
    return copy;
  }

  /* ---------- クーンズパッチ評価 (仕様 4.1) ---------- */

  /** エッジ (a→b) の 3 次ベジェ制御点 [P0, P1, P2, P3]。
   *  ハンドル未設定 (長さ 0) の側は線分の 1/3・2/3 地点を制御点に使い、
   *  3 次ベジェが真の直線 (パラメータ線形) になるようにする。 */
  edgePoints(a: MwNode, b: MwNode, space: MwSpace): [Pt, Pt, Pt, Pt] {
    const p0 = this.nodePos(a.id, space);
    const p3 = this.nodePos(b.id, space);
    const ha = (space === "home" ? a.homeHandles : a.posHandles).get(b.id);
    const hb = (space === "home" ? b.homeHandles : b.posHandles).get(a.id);
    const p1 = ha && len2(ha) > 1e-18 ? addPt(p0, ha) : lerpPt(p0, p3, 1 / 3);
    const p2 = hb && len2(hb) > 1e-18 ? addPt(p3, hb) : lerpPt(p0, p3, 2 / 3);
    return [p0, p1, p2, p3];
  }

  /** エッジ (a→b) をパラメータ t ∈ [0,1] で評価する */
  evaluateEdge(aId: number, bId: number, t: number, space: MwSpace): Pt {
    const [p0, p1, p2, p3] = this.edgePoints(this.node(aId), this.node(bId), space);
    return bezierAt(p0, p1, p2, p3, clamp01(t));
  }

  /**
   * 双三次クーンズパッチの評価 (仕様 4.1):
   *   S(u,v) = Lc(u,v) + Ld(u,v) - B(u,v)
   */
  evaluatePatch(patch: MwPatch, u: number, v: number, space: MwSpace): Pt {
    const ct = this.evaluateEdge(patch.tl, patch.tr, u, space);
    const cb = this.evaluateEdge(patch.bl, patch.br, u, space);
    const dl = this.evaluateEdge(patch.tl, patch.bl, v, space);
    const dr = this.evaluateEdge(patch.tr, patch.br, v, space);
    const tl = this.nodePos(patch.tl, space);
    const tr = this.nodePos(patch.tr, space);
    const br = this.nodePos(patch.br, space);
    const bl = this.nodePos(patch.bl, space);
    const su = clamp01(u);
    const sv = clamp01(v);
    const x =
      (1 - sv) * ct.x + sv * cb.x + (1 - su) * dl.x + su * dr.x -
      ((1 - su) * (1 - sv) * tl.x + su * (1 - sv) * tr.x + (1 - su) * sv * bl.x + su * sv * br.x);
    const y =
      (1 - sv) * ct.y + sv * cb.y + (1 - su) * dl.y + su * dr.y -
      ((1 - su) * (1 - sv) * tl.y + su * (1 - sv) * tr.y + (1 - su) * sv * bl.y + su * sv * br.y);
    return { x, y };
  }

  /**
   * クーンズパッチの逆写像: space 空間の点 target に対応するパラメータ (u, v) を
   * ニュートン反復 (ヤコビアンは差分近似) で求める。アフィン近似の初期値から反復し、
   * 結果は [0,1] にクランプする。
   */
  invertPatch(patch: MwPatch, target: Pt, space: MwSpace): { u: number; v: number } {
    const tl = this.nodePos(patch.tl, space);
    const tr = this.nodePos(patch.tr, space);
    const bl = this.nodePos(patch.bl, space);
    const dx = tr.x - tl.x;
    const dy = tr.y - tl.y;
    const ex = bl.x - tl.x;
    const ey = bl.y - tl.y;
    const dd = dx * dx + dy * dy;
    const ee = ex * ex + ey * ey;
    let u = dd > 1e-12 ? ((target.x - tl.x) * dx + (target.y - tl.y) * dy) / dd : 0.5;
    let v = ee > 1e-12 ? ((target.x - tl.x) * ex + (target.y - tl.y) * ey) / ee : 0.5;
    u = clamp01(u);
    v = clamp01(v);

    const h = 1e-4;
    for (let i = 0; i < 12; i++) {
      const s = this.evaluatePatch(patch, u, v, space);
      const fx = s.x - target.x;
      const fy = s.y - target.y;
      if (Math.hypot(fx, fy) < 0.2) break;
      const su = this.evaluatePatch(patch, u + h, v, space);
      const sv = this.evaluatePatch(patch, u, v + h, space);
      const j11 = (su.x - s.x) / h;
      const j21 = (su.y - s.y) / h;
      const j12 = (sv.x - s.x) / h;
      const j22 = (sv.y - s.y) / h;
      const det = j11 * j22 - j12 * j21;
      if (Math.abs(det) < 1e-12) break;
      const du = (j22 * fx - j12 * fy) / det;
      const dv = (j11 * fy - j21 * fx) / det;
      u = clamp01(u - du);
      v = clamp01(v - dv);
    }
    return { u, v };
  }

  /** 点 pos を含むパッチとそのパラメータ (逆写像が収束し、評価誤差が最小のパッチ) */
  patchAt(pos: Pt): { patch: MwPatch; u: number; v: number } | null {
    let best: { patch: MwPatch; u: number; v: number; err: number } | null = null;
    for (const patch of this.patches) {
      const { u, v } = this.invertPatch(patch, pos, "pos");
      if (u < -0.03 || v < -0.03 || u > 1.03 || v > 1.03) continue;
      const s = this.evaluatePatch(patch, u, v, "pos");
      const err = Math.hypot(s.x - pos.x, s.y - pos.y);
      if (err > 2) continue; // 収束しなかった (パッチの外)
      if (!best || err < best.err) best = { patch, u, v, err };
    }
    return best ? { patch: best.patch, u: best.u, v: best.v } : null;
  }

  /* ---------- ヒット判定 ---------- */

  /** 位置 pos の近くのノード (radius はドキュメント px) */
  hitNode(pos: Pt, radius: number): MwNode | null {
    let best: MwNode | null = null;
    let bestD = radius * radius;
    for (const n of this.nodes.values()) {
      const dx = n.pos.x - pos.x;
      const dy = n.pos.y - pos.y;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  /**
   * 全エッジ (水平 / 垂直) をサンプリングして pos に最も近いエッジを探す
   * (radius はドキュメント px)。t はエッジ a→b 向きに正規化する。
   */
  hitEdge(pos: Pt, radius: number): MwEdgeHit | null {
    const candidates: MwEdgeHit[] = [];
    const samples = 10;
    // 水平エッジ (行 r の列 c ↔ c+1)
    for (let r = 0; r < this.rowCount; r++) {
      for (let c = 0; c < this.colCount - 1; c++) {
        const aId = this.rows[r][c];
        const bId = this.rows[r][c + 1];
        const [p0, p1, p2, p3] = this.edgePoints(this.node(aId), this.node(bId), "pos");
        for (let k = 0; k <= samples; k++) {
          const t = k / samples;
          const p = bezierAt(p0, p1, p2, p3, t);
          const distance = Math.hypot(p.x - pos.x, p.y - pos.y);
          if (distance <= radius) candidates.push({ horizontal: true, line: r, segment: c, aId, bId, t, distance });
        }
      }
    }
    // 垂直エッジ (列 c の行 r ↔ r+1)
    for (let c = 0; c < this.colCount; c++) {
      for (let r = 0; r < this.rowCount - 1; r++) {
        const aId = this.rows[r][c];
        const bId = this.rows[r + 1][c];
        const [p0, p1, p2, p3] = this.edgePoints(this.node(aId), this.node(bId), "pos");
        for (let k = 0; k <= samples; k++) {
          const t = k / samples;
          const p = bezierAt(p0, p1, p2, p3, t);
          const distance = Math.hypot(p.x - pos.x, p.y - pos.y);
          if (distance <= radius) candidates.push({ horizontal: false, line: c, segment: r, aId, bId, t, distance });
        }
      }
    }
    if (candidates.length === 0) return null;
    let best = candidates[0];
    for (const h of candidates) {
      if (h.distance < best.distance) best = h;
    }
    // 最寄りサンプルの近傍で t を精緻化
    const [p0, p1, p2, p3] = this.edgePoints(this.node(best.aId), this.node(best.bId), "pos");
    const step = 1 / samples;
    let bt = best.t;
    let bd = best.distance;
    for (let k = -4; k <= 4; k++) {
      const t = clamp01(best.t + (k / 4) * step);
      const p = bezierAt(p0, p1, p2, p3, t);
      const d = Math.hypot(p.x - pos.x, p.y - pos.y);
      if (d < bd) {
        bd = d;
        bt = t;
      }
    }
    return { ...best, t: bt, distance: bd };
  }

  /** ノード id の隣接ノード (エッジで直結するノード) の ID 一覧 */
  neighborIdsOf(id: number): number[] {
    const [r, c] = this.indexOfNode(id);
    const out: number[] = [];
    if (c > 0) out.push(this.rows[r][c - 1]);
    if (c < this.colCount - 1) out.push(this.rows[r][c + 1]);
    if (r > 0) out.push(this.rows[r - 1][c]);
    if (r < this.rowCount - 1) out.push(this.rows[r + 1][c]);
    return out;
  }

  /**
   * ハンドル (nodeId から neighborId 方向) の表示 / 操作位置。
   * 未編集 (長さ 0) のハンドルは隣接ノード方向へエッジ長の 1/3 の「仮想位置」で表示し、
   * ドラッグ開始点として扱える (実データは動かした分だけ記録する)。
   */
  handleTarget(nodeId: number, neighborId: number): { point: Pt; virtual: boolean } {
    const n = this.node(nodeId);
    const h = n.posHandles.get(neighborId);
    if (h && len2(h) > 1e-18) return { point: addPt(n.pos, h), virtual: false };
    const nb = this.node(neighborId);
    const dir = subPt(nb.pos, n.pos);
    const d = Math.hypot(dir.x, dir.y);
    const unit = d > 1e-6 ? mulPt(dir, 1 / d) : { x: 1, y: 0 };
    return { point: addPt(n.pos, mulPt(unit, d > 1e-6 ? d / 3 : 16)), virtual: true };
  }

  /* ---------- 変形操作 (仕様 3.4) ---------- */

  /** ノードを移動する (ハンドルは相対ベクトルのため自動的に平行移動する) */
  moveNode(id: number, delta: Pt): void {
    const n = this.node(id);
    n.pos = { x: n.pos.x + delta.x, y: n.pos.y + delta.y };
  }

  /** ハンドル値を直接設定する (セッションは「ドラッグ開始値 + ΔD」で呼ぶ) */
  setHandle(nodeId: number, neighborId: number, value: Pt): void {
    this.node(nodeId).posHandles.set(neighborId, value);
  }

  /** エッジ直接ドラッグを開始する (開始時の重みとハンドルを記憶) */
  beginEdgeDrag(hit: MwEdgeHit, mousePos: Pt): MwEdgeDrag {
    const a = this.node(hit.aId);
    const b = this.node(hit.bId);
    const s = 1 - hit.t;
    return {
      aId: hit.aId,
      bId: hit.bId,
      baseP1: a.posHandles.get(b.id) ?? { x: 0, y: 0 },
      baseP2: b.posHandles.get(a.id) ?? { x: 0, y: 0 },
      b1: 3 * s * s * hit.t,
      b2: 3 * s * hit.t * hit.t,
      start: mousePos,
    };
  }

  /**
   * エッジ直接ドラッグの適用 (仕様 4.3)。
   * マウス移動 ΔD を擬似逆行列 (最小二乗解) で 2 つのハンドルへ分配するため、
   * ドラッグ点の曲線は常にマウスカーソルに吸いつく。
   */
  applyEdgeDrag(drag: MwEdgeDrag, mouseNow: Pt): void {
    const { w1, w2 } = edgeDragWeights(drag.b1, drag.b2);
    const dx = (mouseNow.x - drag.start.x) * w1;
    const dy = (mouseNow.y - drag.start.y) * w1;
    const ex = (mouseNow.x - drag.start.x) * w2;
    const ey = (mouseNow.y - drag.start.y) * w2;
    this.node(drag.aId).posHandles.set(drag.bId, { x: drag.baseP1.x + dx, y: drag.baseP1.y + dy });
    this.node(drag.bId).posHandles.set(drag.aId, { x: drag.baseP2.x + ex, y: drag.baseP2.y + ey });
  }

  /* ---------- 細分化 (仕様 3.3) — 列 / 行の挿入 (グリッド全体に貫通) ---------- */

  /**
   * エッジのヒット結果に基づきポイントを追加する。
   * 水平エッジ上 → 新しい**列**を全行に、垂直エッジ上 → 新しい**行**を全列に挿入する
   * (ラインは最初の矩形の幅・高さまで貫通する)。
   */
  splitEdgeHit(hit: MwEdgeHit): void {
    if (hit.horizontal) this.splitColumnAt(hit.segment, hit.t);
    else this.splitRowAt(hit.segment, hit.t);
  }

  /**
   * パッチを (u, v) を通る縦横 2 本のラインで分割する (仕様 3.3)。
   * ラインは隣接パッチにも連動して**グリッド全体まで貫通**する
   * (新しい列と行を全行 / 全列に挿入)。
   */
  splitPatchAt(patch: MwPatch, u: number, v: number): void {
    const [r, c] = this.indexOfNode(patch.tl);
    this.splitColumnAt(c, clamp01(u));
    this.splitRowAt(r, clamp01(v));
  }

  /** 列 seg と seg+1 の間に新しい列を挿入する (全行に新ノード。ド・カステリョ、仕様 4.2) */
  splitColumnAt(seg: number, t: number): void {
    const newIds: number[] = [];
    for (let r = 0; r < this.rowCount; r++) {
      newIds.push(this.splitNodeBetween(this.rows[r][seg], this.rows[r][seg + 1], t));
    }
    for (let r = 0; r < this.rowCount; r++) {
      this.rows[r].splice(seg + 1, 0, newIds[r]);
    }
  }

  /** 行 seg と seg+1 の間に新しい行を挿入する (全列に新ノード。ド・カステリョ、仕様 4.2) */
  splitRowAt(seg: number, t: number): void {
    const newRow: number[] = [];
    for (let c = 0; c < this.colCount; c++) {
      newRow.push(this.splitNodeBetween(this.rows[seg][c], this.rows[seg + 1][c], t));
    }
    this.rows.splice(seg + 1, 0, newRow);
  }

  /**
   * エッジ (a→b) をパラメータ t で 2 分割する新ノードを生成する (ド・カステリョ、仕様 4.2)。
   * 分割後の 2 セグメント [P0, L1, L2, C] / [C, R2, R1, P3] が元の曲線を正確に継承するよう、
   * a / b の相手方向ハンドルを部分曲線の制御点 (L1 / R1) へ更新し、キーを新ノード方向へ付け替える。
   * 行列 (rows) への挿入は呼び出し側が行う。
   */
  private splitNodeBetween(aId: number, bId: number, t: number): number {
    const a = this.node(aId);
    const b = this.node(bId);
    const homePts = this.edgePoints(a, b, "home");
    const posPts = this.edgePoints(a, b, "pos");
    const dh = deCasteljau(homePts[0], homePts[1], homePts[2], homePts[3], t);
    const dp = deCasteljau(posPts[0], posPts[1], posPts[2], posPts[3], t);

    // a の b 方向ハンドル → L1 − P0 / b の a 方向ハンドル → R1 − P3 (部分曲線の第 2 制御点)
    a.homeHandles.set(bId, subPt(lerpPt(homePts[0], homePts[1], t), homePts[0]));
    a.posHandles.set(bId, subPt(lerpPt(posPts[0], posPts[1], t), posPts[0]));
    b.homeHandles.set(aId, subPt(lerpPt(homePts[2], homePts[3], t), homePts[3]));
    b.posHandles.set(aId, subPt(lerpPt(posPts[2], posPts[3], t), posPts[3]));

    // 新ノード m: 分割点 C。両方向のハンドルは L2 − C / R2 − C
    const id = this.nextId++;
    this.nodes.set(id, {
      id,
      home: dh.c,
      pos: dp.c,
      homeHandles: new Map([
        [aId, subPt(dh.l2, dh.c)],
        [bId, subPt(dh.r2, dh.c)],
      ]),
      posHandles: new Map([
        [aId, subPt(dp.l2, dp.c)],
        [bId, subPt(dp.r2, dp.c)],
      ]),
    });
    // エッジ (a→b) が (a→m) と (m→b) に分かれるため、a / b のハンドルキーを m.id へ付け替える
    this.renameHandle(a, bId, id);
    this.renameHandle(b, aId, id);
    return id;
  }

  /** ノード n が保持する「oldId 方向のハンドル」のキーを newId へ付け替える (ハンドル値は不変) */
  private renameHandle(n: MwNode, oldId: number, newId: number): void {
    const p = n.posHandles.get(oldId);
    if (p) {
      n.posHandles.delete(oldId);
      n.posHandles.set(newId, p);
    }
    const h = n.homeHandles.get(oldId);
    if (h) {
      n.homeHandles.delete(oldId);
      n.homeHandles.set(newId, h);
    }
  }

  /** ノード id の行列位置 [行, 列] (見つからない場合は [-1, -1]) */
  private indexOfNode(id: number): [number, number] {
    for (let r = 0; r < this.rowCount; r++) {
      const c = this.rows[r].indexOf(id);
      if (c >= 0) return [r, c];
    }
    return [-1, -1];
  }
}
