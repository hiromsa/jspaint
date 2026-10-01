/**
 * meshwarp/meshGrid.ts — メッシュワープのグリッド (Node / Edge / Patch) とその数理ロジック
 *
 * データ構造 (仕様 2):
 * - Node  : 座標 (home = 変形前 / pos = 変形後) と、隣接方向ごとのベジェハンドル (相対ベクトル)
 * - Edge  : 2 つの Node を結ぶ 3 次ベジェ曲線。コーナー間に中間 Node がある場合はその連鎖 (chain)
 * - Patch : 4 つの Node と 4 つの Edge chain で囲まれた領域。内部の変形は双三次クーンズパッチ
 *
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

/** 4 つの Node と 4 つの Edge chain で囲まれたパッチ (chain は両端のコーナーを含む ID 列) */
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

/** エッジのヒット結果 (セグメント a→b 上のパラメータ t。a→b 向きに正規化) */
export interface MwEdgeHit {
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
 * メッシュワープのグリッド。Node (id / home / pos / ハンドル) と Patch の集合を管理し、
 * クーンズパッチ評価・細分化・エッジ操作を提供する。
 */
export class MeshWarpGrid {
  readonly nodes = new Map<number, MwNode>();
  readonly patches: MwPatch[] = [];
  private nextId = 1;

  /** 対象矩形 (右上は排他) を囲む 4 ノード・1 パッチの初期グリッドを作る (仕様 3.1) */
  static createRect(x0: number, y0: number, x1: number, y1: number): MeshWarpGrid {
    const grid = new MeshWarpGrid();
    const tl = grid.addNode(x0, y0);
    const tr = grid.addNode(x1, y0);
    const br = grid.addNode(x1, y1);
    const bl = grid.addNode(x0, y1);
    grid.patches.push({ tl, tr, br, bl, top: [tl, tr], right: [tr, br], bottom: [bl, br], left: [tl, bl] });
    return grid;
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

  /**
   * chain のセグメント毎の u 区間 (home 空間の制御点折れ線長に比例)。
   * home / pos 両空間で同じ区間割り当てを使うことで、同じ u が両空間の対応点を指す。
   */
  private chainRanges(chain: number[]): { a: MwNode; b: MwNode; start: number; width: number }[] {
    const segs: { a: MwNode; b: MwNode; len: number }[] = [];
    let total = 0;
    for (let i = 0; i < chain.length - 1; i++) {
      const a = this.node(chain[i]);
      const b = this.node(chain[i + 1]);
      const [p0, p1, p2, p3] = this.edgePoints(a, b, "home");
      // 3 次ベジェの弧長を制御点折れ線で近似
      const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y) + Math.hypot(p3.x - p2.x, p3.y - p2.y);
      segs.push({ a, b, len });
      total += len;
    }
    let start = 0;
    return segs.map((s) => {
      const width = total > 1e-12 ? s.len / total : 1 / Math.max(1, segs.length);
      const range = { a: s.a, b: s.b, start, width };
      start += width;
      return range;
    });
  }

  /** エッジ chain (複数セグメントのベジェ連鎖) をパラメータ u ∈ [0,1] で評価する */
  evaluateChain(chain: number[], u: number, space: MwSpace): Pt {
    const ranges = this.chainRanges(chain);
    const uu = clamp01(u);
    for (const r of ranges) {
      if (uu <= r.start + r.width + 1e-9) {
        const t = r.width > 1e-12 ? clamp01((uu - r.start) / r.width) : 0.5;
        const [p0, p1, p2, p3] = this.edgePoints(r.a, r.b, space);
        return bezierAt(p0, p1, p2, p3, t);
      }
    }
    // 浮動小数誤差で見つからない場合 (u ≈ 1) は終点ノードを返す
    const last = ranges[ranges.length - 1];
    return this.nodePos(last.b.id, space);
  }

  /**
   * 双三次クーンズパッチの評価 (仕様 4.1):
   *   S(u,v) = Lc(u,v) + Ld(u,v) - B(u,v)
   */
  evaluatePatch(patch: MwPatch, u: number, v: number, space: MwSpace): Pt {
    const ct = this.evaluateChain(patch.top, u, space);
    const cb = this.evaluateChain(patch.bottom, u, space);
    const dl = this.evaluateChain(patch.left, v, space);
    const dr = this.evaluateChain(patch.right, v, space);
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
   * エッジ chain の全セグメントをサンプリングして pos に最も近いエッジを探す
   * (radius はドキュメント px)。t はセグメント a→b 向きに正規化する。
   */
  hitEdge(pos: Pt, radius: number): MwEdgeHit | null {
    let best: MwEdgeHit | null = null;
    const seen = new Set<string>(); // 隣接パッチで共有されるセグメントの重複評価を避ける
    const samples = 10;
    for (const patch of this.patches) {
      for (const side of MW_SIDES) {
        const chain = patch[side];
        for (let i = 0; i < chain.length - 1; i++) {
          const aId = chain[i];
          const bId = chain[i + 1];
          const key = aId < bId ? `${aId},${bId}` : `${bId},${aId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const [p0, p1, p2, p3] = this.edgePoints(this.node(aId), this.node(bId), "pos");
          for (let k = 0; k <= samples; k++) {
            const t = k / samples;
            const p = bezierAt(p0, p1, p2, p3, t);
            const d = Math.hypot(p.x - pos.x, p.y - pos.y);
            if (d <= radius && (!best || d < best.distance)) {
              best = { aId, bId, t, distance: d };
            }
          }
        }
      }
    }
    if (!best) return null;
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
    return { aId: best.aId, bId: best.bId, t: bt, distance: bd };
  }

  /** ノード id の隣接ノード (エッジで直結するノード) の ID 一覧 */
  neighborIdsOf(id: number): number[] {
    const out = new Set<number>();
    for (const patch of this.patches) {
      for (const side of MW_SIDES) {
        const chain = patch[side];
        for (let i = 0; i < chain.length; i++) {
          if (chain[i] !== id) continue;
          if (i > 0) out.add(chain[i - 1]);
          if (i < chain.length - 1) out.add(chain[i + 1]);
        }
      }
    }
    return [...out];
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

  /* ---------- 細分化 (仕様 3.3) ---------- */

  /**
   * エッジセグメント (a→b) をパラメータ t で 2 分割する (ド・カステリョ、仕様 4.2)。
   * home / pos 両空間で分割し、新ノードに両空間のハンドルを設定する。
   * chain を共有する全パッチ (隣接パッチ) にも新ノードを挿入する。新ノードの ID を返す。
   */
  splitEdgeAt(aId: number, bId: number, t: number): number {
    const a = this.node(aId);
    const b = this.node(bId);
    const homePts = this.edgePoints(a, b, "home");
    const posPts = this.edgePoints(a, b, "pos");
    const dh = deCasteljau(homePts[0], homePts[1], homePts[2], homePts[3], t);
    const dp = deCasteljau(posPts[0], posPts[1], posPts[2], posPts[3], t);

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

    // 元の両端ノードのハンドル (分割前の第 2 制御点 P1 / P2) はそのまま前半 / 後半で使えるため更新不要
    this.insertIntoChains(aId, bId, id);
    return id;
  }

  /** hitEdge の結果でエッジを分割する */
  splitEdgeHit(hit: MwEdgeHit): number {
    return this.splitEdgeAt(hit.aId, hit.bId, hit.t);
  }

  /** 全パッチの chain のうち (a→b) / (b→a) の連続ペアを (a→m→b) に置換する */
  private insertIntoChains(aId: number, bId: number, mId: number): void {
    for (const patch of this.patches) {
      for (const side of MW_SIDES) {
        const chain = patch[side];
        for (let i = 0; i < chain.length - 1; i++) {
          if (chain[i] === aId && chain[i + 1] === bId) {
            chain.splice(i + 1, 0, mId);
            break;
          }
          if (chain[i] === bId && chain[i + 1] === aId) {
            chain.splice(i + 1, 0, mId);
            break;
          }
        }
      }
    }
  }

  /**
   * パッチを (u, v) を通る縦横 2 本のラインで 4 分割する (仕様 3.3)。
   * 4 辺に新ノードを追加し (隣接パッチの chain も連動更新)、中心に新ノードを置く。
   */
  splitPatch(patch: MwPatch, u: number, v: number): void {
    const cu = clamp01(u);
    const cv = clamp01(v);
    const tId = this.splitEdgeOnChain(patch, "top", cu);
    const bId = this.splitEdgeOnChain(patch, "bottom", cu);
    const lId = this.splitEdgeOnChain(patch, "left", cv);
    const rId = this.splitEdgeOnChain(patch, "right", cv);

    // 中心ノード (home / pos 両空間のクーンズパッチ評価)
    const homeC = this.evaluatePatch(patch, cu, cv, "home");
    const posC = this.evaluatePatch(patch, cu, cv, "pos");
    const cId = this.nextId++;
    this.nodes.set(cId, {
      id: cId,
      home: homeC,
      pos: posC,
      homeHandles: new Map(),
      posHandles: new Map(),
    });

    // 分割後の chain (insertIntoChains で各 chain に新ノードが挿入済み)
    const topA = patch.top.slice(0, patch.top.indexOf(tId) + 1);
    const topB = patch.top.slice(patch.top.indexOf(tId));
    const bottomA = patch.bottom.slice(0, patch.bottom.indexOf(bId) + 1);
    const bottomB = patch.bottom.slice(patch.bottom.indexOf(bId));
    const leftA = patch.left.slice(0, patch.left.indexOf(lId) + 1);
    const leftB = patch.left.slice(patch.left.indexOf(lId));
    const rightA = patch.right.slice(0, patch.right.indexOf(rId) + 1);
    const rightB = patch.right.slice(patch.right.indexOf(rId));

    const idx = this.patches.indexOf(patch);
    const tlPatch: MwPatch = { tl: patch.tl, tr: tId, br: cId, bl: lId, top: topA, right: [tId, cId], bottom: [lId, cId], left: leftA };
    const trPatch: MwPatch = { tl: tId, tr: patch.tr, br: rId, bl: cId, top: topB, right: rightA, bottom: [cId, rId], left: [tId, cId] };
    const blPatch: MwPatch = { tl: lId, tr: cId, br: bId, bl: patch.bl, top: [lId, cId], right: [cId, bId], bottom: bottomA, left: leftB };
    const brPatch: MwPatch = { tl: cId, tr: rId, br: patch.br, bl: bId, top: [cId, rId], right: rightB, bottom: bottomB, left: [cId, bId] };
    this.patches.splice(idx, 1, tlPatch, trPatch, blPatch, brPatch);
  }

  /** パッチの指定辺をパラメータ u (chain 全体基準) で分割する → 新ノード ID */
  private splitEdgeOnChain(patch: MwPatch, side: MwSide, u: number): number {
    const chain = patch[side];
    const ranges = this.chainRanges(chain);
    const uu = clamp01(u);
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      if (uu <= r.start + r.width + 1e-9) {
        const t = r.width > 1e-12 ? clamp01((uu - r.start) / r.width) : 0.5;
        return this.splitEdgeAt(r.a.id, r.b.id, t);
      }
    }
    // u ≈ 1 は最終セグメントの終端側で分割
    const last = ranges[ranges.length - 1];
    return this.splitEdgeAt(last.a.id, last.b.id, 0.999999);
  }
}
