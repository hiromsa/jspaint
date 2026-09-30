/**
 * painting/filterPen.ts — フィルターペン (なぞった範囲にフィルターを焼き込む)
 * フィルターペン専用のフィルター設定 (filterPenFx・ツールタブで編集) を、
 * ペンでなぞった範囲のピクセルへ直接適用する。
 * 1ストローク内は開始時の画像を基準にするため、重ね塗りしてもフィルターが二重に効かない。
 */
import { clone, createCanvas } from "../core/canvasUtils";
import { doc } from "../core/documentStore";
import { filterPenFx, FilterSettings } from "../core/filterEngine";
import { selection } from "../core/selectionStore";
import { state } from "../core/editorState";
import { drawLineSeg, ensureStrokeTmp, getStrokeTmp, strokeTmpCtx } from "./stroke";
import type { Pt } from "../core/types";

/** ストローク開始時の対象レイヤースナップショット。基準画像を固定することで、同一ストローク内で重ね塗りしてもフィルターが二重に効かない */
const filterPenBase = new Map<number, HTMLCanvasElement>();
/** ペンでなぞった領域の累積マスク (白 = 適用済み) */
const filterPenMask = document.createElement("canvas");
const filterPenMaskCtx = filterPenMask.getContext("2d")!;

/** ペンマスクをドキュメント実寸へ合わせる (サイズ変更時に内容はクリアされる) */
function ensurePenMask(w: number, h: number): void {
  if (filterPenMask.width !== w) filterPenMask.width = w;
  if (filterPenMask.height !== h) filterPenMask.height = h;
}

/** ストローク開始: 対象レイヤーのスナップショットを取り、ペンマスクを初期化して最初の点を焼き込む */
export function beginFilterPenStroke(at: Pt): void {
  filterPenBase.clear();
  doc.editTargets().forEach((l) => filterPenBase.set(l.id, clone(l.canvas)));
  ensurePenMask(doc.width, doc.height);
  filterPenMaskCtx.clearRect(0, 0, doc.width, doc.height);
  applyFilterPenSegment(at, at);
}

/** ストローク終了: スナップショットを解放する */
export function endFilterPenStroke(): void {
  filterPenBase.clear();
}

/**
 * セグメント (from→to) をペンマスクに追記し、その bbox に対して
 * 「ストローク開始時スナップショット + 現在のフィルター設定」を焼き込む。
 * 効果の基準はストローク開始時の画像なので、なぞり直してもフィルター強度は一定
 * (確定前のフィルタープレビューとは独立に、ピクセルへ直接適用される)。
 */
export function applyFilterPenSegment(from: Pt, to: Pt): void {
  const targets = doc.editTargets();
  if (!targets.length) return;
  // ぼかしのはみ出し分 (blur radius) も bbox に含める
  const blurPad = filterPenFx.on.blur && filterPenFx.blur > 0 ? filterPenFx.blur : 0;
  // シャープのぼかし参照が広い場合もその分はみ出しに含める (参照切れの防止)
  const sharpenPad = filterPenFx.on.sharpen && filterPenFx.sharpen > 0 ? FilterSettings.SHARPEN_RADIUS_MAX : 0;
  const pad = state.brushSize / 2 + 2 + blurPad + sharpenPad;
  const bx = Math.max(0, Math.floor(Math.min(from.x, to.x) - pad));
  const by = Math.max(0, Math.floor(Math.min(from.y, to.y) - pad));
  const br = Math.min(doc.width, Math.ceil(Math.max(from.x, to.x) + pad));
  const bb = Math.min(doc.height, Math.ceil(Math.max(from.y, to.y) + pad));
  const bw = br - bx;
  const bh = bb - by;
  if (bw <= 0 || bh <= 0) return;

  // 1) ペンマスクにセグメントを追記 (累積)
  filterPenMaskCtx.save();
  filterPenMaskCtx.strokeStyle = "#fff";
  filterPenMaskCtx.lineWidth = state.brushSize;
  filterPenMaskCtx.lineCap = "round";
  filterPenMaskCtx.lineJoin = "round";
  drawLineSeg(filterPenMaskCtx, from, to);
  filterPenMaskCtx.restore();

  // 2) bbox: スナップショットにフィルターをかけ、選択範囲 → ペンマスクの順で切り抜いて対象レイヤーへ合成
  ensureStrokeTmp(bw, bh);
  const tg = strokeTmpCtx;
  for (const l of targets) {
    const base = filterPenBase.get(l.id);
    if (!base) continue;
    // ソースを bbox で切り抜き、シャープを事前適用する (CSS filter にシャープは無いため)。
    // pad にぼかし参照半径 (最大 SHARPEN_RADIUS_MAX) 分のはみ出しを含めてあるため、
    // bbox 端での参照切れはペンマスクの外側に限られ、焼き込み結果には影響しない
    const crop = createCanvas(bw, bh);
    crop.getContext("2d")!.drawImage(base, bx, by, bw, bh, 0, 0, bw, bh);
    const source = filterPenFx.applySharpen(crop);
    tg.save();
    tg.translate(-bx, -by);
    tg.globalCompositeOperation = "source-over";
    tg.clearRect(bx, by, bw, bh);
    tg.filter = filterPenFx.filterString();
    tg.drawImage(source, bx, by);
    tg.filter = "none";
    if (filterPenFx.on.noise && filterPenFx.noise > 0) filterPenFx.drawNoise(tg);
    tg.globalCompositeOperation = "destination-in";
    if (selection.hasSelection) {
      tg.drawImage(selection.mask, 0, 0);
    }
    tg.drawImage(filterPenMask, 0, 0);
    tg.restore();
    l.ctx.save();
    l.ctx.globalAlpha = state.opacity / 100;
    l.ctx.drawImage(getStrokeTmp(), bx, by);
    l.ctx.restore();
  }
}