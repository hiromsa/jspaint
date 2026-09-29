/**
 * puppet/deformer.ts — ピンの移動量からメッシュ全頂点の変形先を求める
 * Schaefer et al. (2006) の Moving Least Squares rigid 変形を使用する。
 * 2D では加重剛体レジストレーション (加重 2D Procrustes) の解析解と等価で、
 * 各頂点 v ごとに回転角 θ = atan2(Σw·(P̂×Q̂), Σw·(P̂·Q̂)) を解き f(v) = q* + R·(v − p*) と書ける
 * (p* / q* はピン元 / 先の加重平均・絶対座標)。
 * 移動していないピン (current = original) は自動的にアンカーとして働くため、
 * PuppetPin.isPinned は「ユーザーが動かせないようにしたピン」を示す UX 上の区別。
 */
import type { Pt } from "../core/types";
import type { PuppetMesh } from "./mesh";

/** 重み: ピンからの逆距離2乗 (α=1)。+ε でピン位置そのものの頂点 (距離 0) を許容 */
const PIN_WEIGHT_EPS = 1e-6;

/** ピンの current 位置に基づき、全頂点の変形後座標を計算する */
export function computeDeformedVertices(mesh: PuppetMesh): Pt[] {
  const out: Pt[] = new Array(mesh.vertices.length);
  const pins = mesh.pins;
  if (pins.length === 0) {
    // ピンが無ければ恒等変形
    for (let i = 0; i < mesh.vertices.length; i++) out[i] = { ...mesh.vertices[i] };
    return out;
  }
  for (let vi = 0; vi < mesh.vertices.length; vi++) {
    const v = mesh.vertices[vi];
    // v からの距離で重み付け (近いピンほど強く効く)
    let sw = 0;
    let pstarX = 0, pstarY = 0;
    let qstarX = 0, qstarY = 0;
    for (const pin of pins) {
      const dx = pin.original.x - v.x;
      const dy = pin.original.y - v.y;
      const w = 1 / (dx * dx + dy * dy + PIN_WEIGHT_EPS);
      sw += w;
      pstarX += w * pin.original.x;
      pstarY += w * pin.original.y;
      qstarX += w * pin.current.x;
      qstarY += w * pin.current.y;
    }
    pstarX /= sw;
    pstarY /= sw;
    qstarX /= sw;
    qstarY /= sw;
    // 加重剛体レジストレーションの回転角 (sin / cos 成分を累積して atan2 で解く)
    let accSin = 0;
    let accCos = 0;
    for (const pin of pins) {
      const dx = pin.original.x - v.x;
      const dy = pin.original.y - v.y;
      const w = 1 / (dx * dx + dy * dy + PIN_WEIGHT_EPS);
      const ax = pin.original.x - pstarX;
      const ay = pin.original.y - pstarY;
      const bx = pin.current.x - qstarX;
      const by = pin.current.y - qstarY;
      accSin += w * (ax * by - ay * bx);
      accCos += w * (ax * bx + ay * by);
    }
    const theta = Math.atan2(accSin, accCos);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const px = v.x - pstarX;
    const py = v.y - pstarY;
    out[vi] = {
      x: qstarX + cos * px - sin * py,
      y: qstarY + sin * px + cos * py,
    };
  }
  return out;
}
