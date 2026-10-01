/**
 * rendering/renderer.ts — ワークスペースへの描画
 * view canvas のサイズ管理と、ドキュメント (レイヤー + 選択) の全体描画を担う。
 */
import { doc } from "../core/documentStore";
import { filters } from "../core/filterEngine";
import { state } from "../core/editorState";
import { selection } from "../core/selectionStore";
import { viewport } from "../core/viewState";
import { drawMaskLayerDisplay } from "./maskDisplay";
import { warpSession } from "../puppet/warpSession";
import { drawCursor, drawDragSizeBadge, drawMeshWarpOverlay, drawPuppetWarpOverlay, drawSelectionPreview, drawStrokePreview } from "./previews";

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
  vctx.translate(-doc.width / 2, -doc.height / 2);

  // チェッカーボード (透明部分の表現)
  const chk = 8;
  vctx.fillStyle = "#1e1e1e";
  vctx.fillRect(0, 0, doc.width, doc.height);
  vctx.fillStyle = "#2a2a2a";
  for (let y = 0; y < doc.height / chk; y++) {
    for (let x = 0; x < doc.width / chk; x++) {
      if ((x + y) % 2 === 0) vctx.fillRect(x * chk, y * chk, chk, chk);
    }
  }

  // レイヤー (下 → 上)。フィルター有効時、編集対象レイヤーは適用済みプレビューに差し替える。
  // パペットワープ中は変形プレビューに差し替える
  // Inpainting マスクレイヤーは Forge 風のドット網掛表示 (レイヤーデータは変更しない)
  for (const l of doc.layers) {
    if (!l.visible) continue;
    const filtered = filters.layerPreview(l);
    const source = filtered ?? warpSession.displayCanvas(l.id) ?? l.canvas;
    if (doc.isInpaintMaskLayer(l)) drawMaskLayerDisplay(vctx, source);
    else vctx.drawImage(source, 0, 0);
  }

  drawStrokePreview(vctx);
  drawPuppetWarpOverlay(vctx);
  drawMeshWarpOverlay(vctx);
  drawSelectionPreview(vctx);

  vctx.restore();

  // ドラッグ中のサイズ表示 (矩形選択 / 図形)
  drawDragSizeBadge(vctx);

  // Marching ants (doc解像度のエッジ層を重ね描き)
  if (selection.hasSelection && selection.antsBlack) {
    vctx.save();
    vctx.translate(viewport.vw / 2 + state.panX, viewport.vh / 2 + state.panY);
    vctx.scale(state.zoom, state.zoom);
    vctx.translate(-doc.width / 2, -doc.height / 2);
    vctx.imageSmoothingEnabled = false;
    vctx.drawImage(selection.antsBlack, 0, 0);
    vctx.drawImage(selection.antsWhite[selection.antPhase % 4], 0, 0);
    vctx.restore();
  }

  drawCursor(vctx);
}