/**
 * painting/bloat.ts — 膨張ブラシ (リキフィ系)
 * 逆マッピング + premultiply バイリニア補間でブラシ中心を基準にピクセルを放射状に押し広げる。
 * 押しっぱなしで時間ベースに持続適用する rAF ホールドループが唯一の適用経路。
 */
import { doc } from "../core/documentStore";
import { state } from "../core/editorState";
import { hooks } from "../core/hooks";
import { interaction } from "../core/interactionState";
import { selection } from "../core/selectionStore";
import { toneFalloff } from "./retouch";
import type { Layer, Pt } from "../core/types";

/** 1 スタンプで中心付近のサンプル距離を縮める最大率。ドラッグ中はスタンプが繰り返し適用され、徐々に膨らむ */
const BLOAT_PULL = 0.32;

/**
 * at を中心に画像を球面状に膨らませる (リキフィの膨張)。
 * 逆マッピング方式: 出力ピクセルごとに「中心方向へ f だけ寄った位置」をバイリニア補間で
 * サンプルし直す。f は中心で最大・円周で 0 のフォールオフなので、中心ほど強く拡大され、
 * 外周へ滑らかに減衰する。sign = -1 で収縮 (ピンチ) に反転。
 * pull は 1 スタンプの引き寄せ率 (ドラッグのスタンプは既定値、ホールド中の連続適用は
 * 経過時間比例の小さい値)。選択範囲がある場合は選択マスクのアルファで効果を減衰する。
 */
export function bloatStamp(target: Layer, at: Pt, sign: 1 | -1, pull: number = BLOAT_PULL): void {
  const size = Math.ceil(state.brushSize);
  const r = state.brushSize / 2;
  const x0 = Math.floor(at.x - r);
  const y0 = Math.floor(at.y - r);
  const sx = Math.max(0, x0);
  const sy = Math.max(0, y0);
  const ex = Math.min(target.canvas.width, x0 + size + 1);
  const ey = Math.min(target.canvas.height, y0 + size + 1);
  if (ex <= sx || ey <= sy) return;
  const ctx = target.ctx;
  const w = ex - sx;
  const h = ey - sy;
  // 現在のピクセルをソースとして保持し、結果は別バッファへ書く (円の外側は元のまま)
  const src = ctx.getImageData(sx, sy, w, h);
  const out = ctx.createImageData(w, h);
  out.data.set(src.data);
  const sd = src.data;
  const od = out.data;
  const cx = at.x - sx;
  const cy = at.y - sy;
  const k = (state.opacity / 100) * pull;
  // 選択範囲がある場合は選択マスクのアルファで効果を減衰 (0 = 完全に効果なし)
  const selD = selection.hasSelection ? selection.ctx.getImageData(sx, sy, w, h).data : null;
  for (let y = 0; y < h; y++) {
    const dy = y + 0.5 - cy;
    const dy2 = dy * dy;
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx;
      const t = Math.sqrt(dx * dx + dy2) / r;
      if (t >= 1) continue;
      let f = toneFalloff(t) * k;
      if (f <= 0.0001) continue;
      if (selD) {
        const sa = selD[(y * w + x) * 4 + 3] / 255;
        if (sa <= 0) continue;
        f *= sa;
      }
      // 逆マッピング: 膨張なら中心側へ、収縮なら外側へサンプル位置をずらす
      const m = 1 - sign * f;
      const mx = cx + dx * m;
      const my = cy + dy * m;
      // バイリニア補間 (透過ピクセルを含むため premultiply してから混ぜる)
      // サンプル座標 mx は「ピクセル中心 = 整数 + 0.5」基準のため、インデックス化する際に
      // -0.5 してから floor する (補正しないと毎スタンプ恒久的に (-0.5, -0.5) px ずれ、
      // 連続適用で画像が左上へ流れてしまう)
      const fx0 = Math.floor(mx - 0.5);
      const fy0 = Math.floor(my - 0.5);
      const rx = mx - 0.5 - fx0;
      const ry = my - 0.5 - fy0;
      const xA = Math.max(0, Math.min(w - 1, fx0));
      const xB = Math.max(0, Math.min(w - 1, fx0 + 1));
      const yA = Math.max(0, Math.min(h - 1, fy0));
      const yB = Math.max(0, Math.min(h - 1, fy0 + 1));
      const iAA = (yA * w + xA) * 4;
      const iBA = (yA * w + xB) * 4;
      const iAB = (yB * w + xA) * 4;
      const iBB = (yB * w + xB) * 4;
      const wAA = (1 - rx) * (1 - ry);
      const wBA = rx * (1 - ry);
      const wAB = (1 - rx) * ry;
      const wBB = rx * ry;
      const aAA = sd[iAA + 3];
      const aBA = sd[iBA + 3];
      const aAB = sd[iAB + 3];
      const aBB = sd[iBB + 3];
      const a = wAA * aAA + wBA * aBA + wAB * aAB + wBB * aBB;
      const o = (y * w + x) * 4;
      if (a <= 0) {
        od[o + 3] = 0;
        continue;
      }
      const inv = 1 / a;
      od[o] = (wAA * aAA * sd[iAA] + wBA * aBA * sd[iBA] + wAB * aAB * sd[iAB] + wBB * aBB * sd[iBB]) * inv;
      od[o + 1] = (wAA * aAA * sd[iAA + 1] + wBA * aBA * sd[iBA + 1] + wAB * aAB * sd[iAB + 1] + wBB * aBB * sd[iBB + 1]) * inv;
      od[o + 2] = (wAA * aAA * sd[iAA + 2] + wBA * aBA * sd[iBA + 2] + wAB * aAB * sd[iAB + 2] + wBB * aBB * sd[iBB + 2]) * inv;
      od[o + 3] = a;
    }
  }
  ctx.putImageData(out, sx, sy);
}

/** 実効方向: パネル設定 (state.bloatDir) × Alt 一時反転 */
export function bloatSign(alt: boolean): 1 | -1 {
  return state.bloatDir * (alt ? -1 : 1) < 0 ? -1 : 1;
}

/* --- ホールド中の連続変形 (押し続けている間、カーソル位置でゆっくり変形し続ける) --- */
/** 1 秒押し続けたときの引き寄せ率 (強さスライダーで比例) */
export const BLOAT_HOLD_RATE = 0.42;
let bloatHoldRaf = 0;
let bloatHoldLast = 0;
/** 最後にスタンプした位置 (rAF フレーム間の移動を補間するため保持) */
let bloatHoldPos: Pt | null = null;

function bloatHoldTick(now: number): void {
  const at = interaction.retouchLast;
  if (!at || state.tool !== "bloat") {
    bloatHoldRaf = 0;
    bloatHoldPos = null;
    return;
  }
  const dt = Math.min(0.1, (now - bloatHoldLast) / 1000);
  bloatHoldLast = now;
  // 前回適用位置 → 現在位置をブラシ径の 1/4 間隔で補間 (素早く動かしても塗り残しが出ないように)
  const from = bloatHoldPos ?? at;
  const dist = Math.hypot(at.x - from.x, at.y - from.y);
  const step = Math.max(1, state.brushSize * 0.25);
  const n = Math.max(1, Math.ceil(dist / step));
  // 合計の適用率が常に時間比例 (BLOAT_HOLD_RATE × dt) になるよう 1 スタンプ分ずつ配分する
  const pull = Math.min(BLOAT_PULL, (BLOAT_HOLD_RATE * dt) / n);
  if (pull > 0.0005) {
    const sign = bloatSign(interaction.altKey);
    doc.editTargets().forEach((l) => {
      for (let i = 1; i <= n; i++) {
        bloatStamp(l, { x: from.x + ((at.x - from.x) * i) / n, y: from.y + ((at.y - from.y) * i) / n }, sign, pull);
      }
    });
    hooks.render();
  }
  bloatHoldPos = at;
  bloatHoldRaf = requestAnimationFrame(bloatHoldTick);
}

export function startBloatHold(): void {
  bloatHoldLast = performance.now();
  bloatHoldPos = null;
  if (bloatHoldRaf) cancelAnimationFrame(bloatHoldRaf);
  bloatHoldRaf = requestAnimationFrame(bloatHoldTick);
}

export function stopBloatHold(): void {
  if (bloatHoldRaf) cancelAnimationFrame(bloatHoldRaf);
  bloatHoldRaf = 0;
}