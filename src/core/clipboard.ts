/**
 * core/clipboard.ts — 選択範囲のコピーペースト (内部クリップボード)
 * 編集対象レイヤーの選択範囲内容をコピーし、新規レイヤーとして貼り付ける
 * (Photoshop / Affinity Photo と同じレイヤー指向のコピー&ペースト)。
 * 外部 (OS) クリップボードの扱いは ui/imageIO.ts が担当する。
 */
import { createCanvas } from "./canvasUtils";
import { doc } from "./documentStore";
import { history } from "./historyStack";
import { hooks } from "./hooks";
import { selection } from "./selectionStore";

/** 内部クリップボードの内容 (貼り付け位置を保持する) */
interface InternalClipboard {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
}

let internal: InternalClipboard | null = null;

/** 内部クリップボードに内容があるか */
export function hasInternal(): boolean {
  return internal !== null;
}

/** canvas 内の不透明ピクセルの外接矩形を求める (全透明なら null) */
function contentBounds(g: CanvasRenderingContext2D, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  const d = g.getImageData(0, 0, w, h).data;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * 選択範囲 (選択なしの場合は編集対象レイヤーの全体) の内容を
 * 内部クリップボードへコピーする。成功時 true。
 */
export function copySelection(): boolean {
  const targets = doc.editTargets();
  if (!targets.length) {
    hooks.toast("編集可能 (ロック解除) なレイヤーがありません", "info");
    return false;
  }
  const composite = createCanvas(doc.width, doc.height);
  const g = composite.getContext("2d")!;
  for (const l of targets) {
    if (l.visible) g.drawImage(l.canvas, 0, 0);
  }
  if (selection.hasSelection) {
    g.globalCompositeOperation = "destination-in";
    g.drawImage(selection.mask, 0, 0);
    g.globalCompositeOperation = "source-over";
  }
  const bbox = contentBounds(g, doc.width, doc.height);
  if (!bbox) {
    hooks.toast("コピーする内容がありません", "info");
    return false;
  }
  const cropped = createCanvas(bbox.w, bbox.h);
  cropped.getContext("2d")!.drawImage(composite, -bbox.x, -bbox.y);
  internal = { canvas: cropped, x: bbox.x, y: bbox.y };
  hooks.toast(
    selection.hasSelection
      ? `選択範囲 (${bbox.w}×${bbox.h}) をコピーしました · Ctrl+V で新規レイヤーに貼り付け`
      : `編集対象レイヤー全体 (${bbox.w}×${bbox.h}) をコピーしました · Ctrl+V で新規レイヤーに貼り付け`,
    "ok",
  );
  return true;
}

/** 選択範囲 (または編集対象レイヤー全体) を切り取って内部クリップボードへコピーする。成功時 true */
export function cutSelection(): boolean {
  if (!copySelection()) return false;
  history.pushUndo();
  const targets = doc.editTargets();
  for (const l of targets) {
    l.ctx.save();
    l.ctx.globalCompositeOperation = "destination-out";
    if (selection.hasSelection) l.ctx.drawImage(selection.mask, 0, 0);
    else l.ctx.clearRect(0, 0, doc.width, doc.height);
    l.ctx.restore();
  }
  hooks.markDirty();
  hooks.render();
  hooks.toast(selection.hasSelection ? "選択範囲を切り取りました" : "編集対象レイヤーの内容を切り取りました", "ok");
  return true;
}

/** 内部クリップボードの内容を新規レイヤーとして元の位置に貼り付ける。成功時 true */
export function pasteAsLayer(): boolean {
  if (!internal) return false;
  const l = doc.addLayer();
  l.ctx.drawImage(internal.canvas, internal.x, internal.y);
  hooks.markDirty();
  hooks.render();
  return true;
}