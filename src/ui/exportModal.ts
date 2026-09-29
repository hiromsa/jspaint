/**
 * ui/exportModal.ts — ヘッダー操作と Inpainting エクスポートモーダル
 * 合成画像 / 白黒マスクの生成・プレビュー・PNG保存・親アプリへの postMessage を担う。
 */
import { doc } from "../core/documentStore";
import { filters } from "../core/filterEngine";
import { history } from "../core/historyStack";
import { selection } from "../core/selectionStore";
import { state } from "../core/editorState";
import { fitView, setZoom } from "../core/viewState";
import { cancelPolygon } from "../interaction/pointer";
import { render } from "../rendering/renderer";
import { renderLayers } from "../ui/layersPanel";
import { syncFilterUI } from "./filtersPanel";
import { hostMode } from "./hostMode";
import { $, $$ } from "./dom";
import { toast } from "./feedback";

let exportCompositeUrl = "";
let exportMaskUrl = "";

function buildMaskUrl(): string {
  const w = doc.width;
  const h = doc.height;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000000";
  g.fillRect(0, 0, w, h);

  // ペイントレイヤーを白で加算
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tg = tmp.getContext("2d")!;
  for (const l of doc.layers) {
    if (l.kind !== "paint" || !l.visible) continue;
    tg.globalCompositeOperation = "source-over";
    tg.clearRect(0, 0, w, h);
    tg.drawImage(l.canvas, 0, 0);
    tg.globalCompositeOperation = "source-in";
    tg.fillStyle = "#ffffff";
    tg.fillRect(0, 0, w, h);
    g.drawImage(tmp, 0, 0);
  }
  // 最終選択範囲を白で加算
  if (selection.hasSelection) g.drawImage(selection.mask, 0, 0);
  return c.toDataURL("image/png");
}

export function openExport(): void {
  cancelPolygon();
  exportCompositeUrl = doc.compositeCanvas().toDataURL("image/png");
  exportMaskUrl = buildMaskUrl();
  $("#exp-composite").setAttribute("src", exportCompositeUrl);
  $("#exp-mask").setAttribute("src", exportMaskUrl);
  const info = $("#export-info");
  info.classList.remove("is-sent", "is-error");
  info.textContent = `$ JSPAINT_EXPORT · ${doc.width}×${doc.height} · mask = 描画要素 + 最終選択範囲 → 待機中…`;
  ($("#modal-export") as HTMLElement).hidden = false;
}

export function closeExport(): void {
  ($("#modal-export") as HTMLElement).hidden = true;
}

/** data URL をファイルダウンロードする (保存ボタン / エクスポートモーダル共用) */
export function downloadDataUrl(name: string, url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

function postToParent(): void {
  const payload = { type: "JSPAINT_EXPORT", compositeImage: exportCompositeUrl, maskImage: exportMaskUrl };
  const info = $("#export-info");
  if (window.parent !== window) {
    window.parent.postMessage(payload, "*");
    info.textContent = '→ window.parent.postMessage({ type: "JSPAINT_EXPORT", compositeImage, maskImage }) 送信済み ✓';
    info.classList.add("is-sent");
    toast("親アプリへ送信しました", "ok");
  } else {
    info.textContent = `⚠ standalone モード (iframe未検出 / mode=${hostMode}) — 各PNG保存ボタンでダウンロードしてください`;
    info.classList.add("is-error");
    toast("standalone モードのため PNG 保存で代替します", "info");
  }
}

export function bindHeaderAndModal(): void {
  $("#btn-undo").addEventListener("click", () => history.undo());
  $("#btn-redo").addEventListener("click", () => history.redo());
  $("#btn-zoomin").addEventListener("click", () => setZoom(state.zoom * 1.25));
  $("#btn-zoomout").addEventListener("click", () => setZoom(state.zoom / 1.25));
  $("#btn-zoom-label").addEventListener("click", () => setZoom(1));
  $("#btn-fit").addEventListener("click", fitView);
  $("#btn-export").addEventListener("click", openExport);

  $("#btn-cancel").addEventListener("click", () => {
    doc.layers.filter((l) => l.kind === "paint").forEach((l) => l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height));
    selection.clearSelection();
    filters.resetValues();
    syncFilterUI();
    history.clear();
    renderLayers();
    render();
    toast("編集をリセットしました", "info");
  });

  $("#modal-close").addEventListener("click", closeExport);
  $("#modal-cancel").addEventListener("click", closeExport);
  $("#modal-backdrop").addEventListener("click", closeExport);
  $("#btn-postmessage").addEventListener("click", postToParent);
  $$("[data-dl]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const which = (btn as HTMLElement).dataset.dl;
      downloadDataUrl(
        which === "mask" ? "mask.png" : "composite.png",
        which === "mask" ? exportMaskUrl : exportCompositeUrl,
      );
    }),
  );
}