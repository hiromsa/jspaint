/**
 * rendering/renderer.ts — ワークスペースへの描画
 * view canvas のサイズ管理と、ドキュメント (レイヤー + 選択) の全体描画を担う。
 */
import { doc } from "../core/documentStore";
import { filters } from "../core/filterEngine";
import { state } from "../core/editorState";
import { selection } from "../core/selectionStore";
import { viewport } from "../core/viewState";
import { DOC_H, DOC_W } from "../core/types";
import { drawCursor, drawDragSizeBadge, drawSelectionPreview, drawStrokePreview } from "./previews";

export const view = document.querySelector("#view") as HTMLCanvasElement;
export const vctx = view.getContext("2d")!;

const workspace = document.querySelector("#workspace")!;

export function resizeView(): void {
  viewport.vw = workspace.clientWidth;
  viewport.vh = workspace.clientHeight;
  view.width = Math.max(1, Math.round(viewport.vw * viewport.dpr));
  view.height = Math.max(1, Math.round(viewport.vh * viewport.dpr));
  view.style.width = `${viewport.vw}px`;
  view.style.height = `${viewport.vh}px`;
  render();
}

export function render(): void {
  if (!viewport.vw) return;
  vctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
  vctx.clearRect(0, 0, viewport.vw, viewport.vh);

  vctx.save();
  vctx.translate(viewport.vw / 2 + state.panX, viewport.vh / 2 + state.panY);
  vctx.scale(state.zoom, state.zoom);
  vctx.translate(-DOC_W / 2, -DOC_H / 2);

  // チェッカーボード (透明部分の表現)
  const chk = 8;
  vctx.fillStyle = "#1e1e1e";
  vctx.fillRect(0, 0, DOC_W, DOC_H);
  vctx.fillStyle = "#2a2a2a";
  for (let y = 0; y < DOC_H / chk; y++) {
    for (let x = 0; x < DOC_W / chk; x++) {
      if ((x + y) % 2 === 0) vctx.fillRect(x * chk, y * chk, chk, chk);
    }
  }

  // 背景レイヤー (前処理フィルター — 選択範囲がある場合はその範囲のみ適用)
  filters.drawBaseLayer(vctx);

  // ペイントレイヤー (下 → 上)
  for (const l of doc.layers) {
    if (l.kind === "paint" && l.visible) vctx.drawImage(l.canvas, 0, 0);
  }

  drawStrokePreview(vctx);
  drawSelectionPreview(vctx);

  vctx.restore();

  // ドラッグ中のサイズ表示 (矩形選択 / 図形)
  drawDragSizeBadge(vctx);

  // Marching ants (doc解像度のエッジ層を重ね描き)
  if (selection.hasSelection && selection.antsBlack) {
    vctx.save();
    vctx.translate(viewport.vw / 2 + state.panX, viewport.vh / 2 + state.panY);
    vctx.scale(state.zoom, state.zoom);
    vctx.translate(-DOC_W / 2, -DOC_H / 2);
    vctx.imageSmoothingEnabled = false;
    vctx.drawImage(selection.antsBlack, 0, 0);
    vctx.drawImage(selection.antsWhite[selection.antPhase % 4], 0, 0);
    vctx.restore();
  }

  drawCursor(vctx);
}