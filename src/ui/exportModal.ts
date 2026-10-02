/**
 * ui/exportModal.ts — ヘッダー操作と Inpainting エクスポートモーダル
 * 合成画像 / 白黒マスクの生成・プレビュー・PNG保存・親アプリへの postMessage を担う。
 */
import { doc } from "../core/documentStore";
import { history } from "../core/historyStack";
import { selection } from "../core/selectionStore";
import { state } from "../core/editorState";
import { resetDocument } from "../core/documentOps";
import { fitView, setZoom } from "../core/viewState";
import { cancelPolygon } from "../interaction/pointer";
import { warpSession } from "../puppet/warpSession";
import { meshWarpSession } from "../meshwarp/warpSession";
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

  // レイヤー canvas を「白の不透明度」に変換してマスクへ加算
  const addWhitened = (canvas: HTMLCanvasElement) => {
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const tg = tmp.getContext("2d")!;
    tg.globalCompositeOperation = "source-over";
    tg.drawImage(canvas, 0, 0);
    tg.globalCompositeOperation = "source-in";
    tg.fillStyle = "#ffffff";
    tg.fillRect(0, 0, w, h);
    g.drawImage(tmp, 0, 0);
  };

  // Inpainting マスクレイヤーが指定されている場合はそのレイヤーのみから生成する
  // (選択範囲は含めない — 指定レイヤーがマスクの唯一のソース)
  const maskLayer = doc.inpaintMaskLayer;
  if (maskLayer) {
    if (maskLayer.visible) addWhitened(maskLayer.canvas);
    return c.toDataURL("image/png");
  }

  // 未指定時は従来どおり: 全ペイントレイヤーを白で加算 + 最終選択範囲を白で加算
  for (const l of doc.layers) {
    if (l.kind !== "paint" || !l.visible) continue;
    addWhitened(l.canvas);
  }
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
  const maskLayer = doc.inpaintMaskLayer;
  const maskInfo = maskLayer ? `Inpainting マスクレイヤー「${maskLayer.name}」` : "描画要素 + 最終選択範囲";
  info.textContent = `$ JSPAINT_EXPORT · ${doc.width}×${doc.height} · mask = ${maskInfo} → 待機中…`;
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
    // 送信済み表示を一瞬見せてから描画画面へ戻る (次回オープン時にエクスポート画面が残らないように)
    setTimeout(() => {
      if (!($("#modal-export") as HTMLElement).hidden) closeExport();
    }, 600);
  } else {
    info.textContent = `⚠ standalone モード (iframe未検出 / mode=${hostMode}) — 各PNG保存ボタンでダウンロードしてください`;
    info.classList.add("is-error");
    toast("standalone モードのため PNG 保存で代替します", "info");
  }
}

export function bindHeaderAndModal(): void {
  $("#btn-undo").addEventListener("click", () => {
    // ワープセッション (パペット / メッシュ) 中はセッション内履歴を優先 (Ctrl+Z と同じ挙動)
    if (warpSession.active) warpSession.undo();
    else if (meshWarpSession.active) meshWarpSession.undo();
    else history.undo();
  });
  $("#btn-redo").addEventListener("click", () => {
    if (warpSession.active) warpSession.redo();
    else if (meshWarpSession.active) meshWarpSession.redo();
    else history.redo();
  });
  $("#btn-zoomin").addEventListener("click", () => setZoom(state.zoom * 1.25));
  $("#btn-zoomout").addEventListener("click", () => setZoom(state.zoom / 1.25));
  $("#btn-zoom-label").addEventListener("click", () => setZoom(1));
  $("#btn-fit").addEventListener("click", fitView);
  $("#btn-export").addEventListener("click", openExport);

  $("#btn-cancel").addEventListener("click", () => {
    resetDocument();
    toast("編集をリセットしました (読み込み直後の状態へ戻しました)", "info");
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