/**
 * ui/imageIO.ts — 画像の入出力 (開く / 保存 / クリップボード / ドラッグ&ドロップ / ペースト)
 *
 * 読み込みには2種類ある:
 *   - ドキュメント差し替え (「開く」/ ドロップ / Ctrl+Shift+V): 画像を元画像レイヤーとして新規ドキュメントを開く
 *   - 新規レイヤー貼り付け (Ctrl+V / 「クリップボードから新規作成」ボタン): 現在のドキュメントにレイヤー追加
 * 内部クリップボード (core/clipboard) にコピーがある場合は Ctrl+V でそれを優先してレイヤー化する。
 * ファイルを開く / 保存は standalone モード専用 (ui/hostMode.ts で UI を切り替え)。
 */
import { hasInternal, pasteAsLayer } from "../core/clipboard";
import { interaction } from "../core/interactionState";
import { applyBaseImage } from "../core/documentOps";
import { doc } from "../core/documentStore";
import { isImageFile, loadImageFromBlob, loadImageFromFile } from "../core/imageSource";
import { cancelPolygon } from "../interaction/pointer";
import { warpSession } from "../puppet/warpSession";
import { downloadDataUrl } from "./exportModal";
import { $ } from "./dom";
import { markClean, markDirty, toast } from "./feedback";

/** 進行中の編集セッションを取り消してから画像をベースとして適用する (ドキュメント差し替え) */
function applyImage(image: HTMLCanvasElement, name?: string): void {
  cancelPolygon();
  if (warpSession.active) warpSession.cancel();
  applyBaseImage(image, name);
  markClean();
  toast(`${name ?? "画像"} (${image.width}×${image.height}) を読み込みました`, "ok");
}

/** 画像を新規レイヤーとして現在のドキュメントへ貼り付ける (中央配置) */
function pasteImageAsLayer(image: HTMLCanvasElement): void {
  cancelPolygon();
  if (warpSession.active) warpSession.cancel();
  const l = doc.addImageLayer(image);
  markDirty();
  toast(`${image.width}×${image.height} の画像を新規レイヤー「${l.name}」として貼り付けました`, "ok");
}

/** ファイルダイアログを開く (standalone モード専用) */
function openFile(): void {
  const input = $("#file-open") as HTMLInputElement;
  input.value = ""; // 同一ファイルの再選択でも change が発火するよう初期化
  input.click();
}

async function handleFile(file: File): Promise<void> {
  try {
    const image = await loadImageFromFile(file);
    applyImage(image, file.name);
  } catch {
    toast(`${file.name} を読み込めませんでした`, "info");
  }
}

/** 拡張子を PNG に揃えた保存用ファイル名を生成する */
function pngName(name: string): string {
  return `${name.replace(/\.[^.]+$/, "")}.png`;
}

/** 合成画像 (全レイヤー) を PNG ファイルへ保存 (standalone モード専用) */
function saveComposite(): void {
  const url = doc.compositeCanvas().toDataURL("image/png");
  downloadDataUrl(pngName(doc.name), url);
  toast(`${pngName(doc.name)} を保存しました`, "ok");
}

/** 合成画像をクリップボードへコピー (両モードで利用可) */
async function copyComposite(): Promise<void> {
  try {
    const blob = await new Promise<Blob | null>((resolve) => doc.compositeCanvas().toBlob(resolve, "image/png"));
    if (!blob) throw new Error("合成画像を生成できませんでした");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("合成画像をクリップボードへコピーしました", "ok");
  } catch {
    toast("クリップボードへコピーできませんでした (ブラウザ / 起動方法が非対応の可能性)", "info");
  }
}

/* ---------- ペースト (Ctrl+V / Ctrl+Shift+V / ボタン) ---------- */

/** OS クリップボードから画像を取り出す (画像がなければ null) */
async function readClipboardImage(): Promise<Blob | null> {
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = item.types.find((t) => t.startsWith("image/"));
    if (type) return item.getType(type);
  }
  return null;
}

/** 「クリップボードから新規作成」ボタン: OS クリップボードの画像を新規レイヤーとして貼り付ける */
async function pasteFromOsClipboardAsLayer(): Promise<void> {
  try {
    const blob = await readClipboardImage();
    if (!blob) {
      toast("クリップボードに画像がありません", "info");
      return;
    }
    const image = await loadImageFromBlob(blob);
    pasteImageAsLayer(image);
  } catch {
    toast("クリップボードを読み取れませんでした (権限が必要な場合があります)", "info");
  }
}

function onPaste(e: ClipboardEvent): void {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  e.preventDefault();
  // keydown で記録した Shift の有無 (Ctrl+Shift+V = ドキュメント差し替え)
  const asDocument = interaction.pasteShift;
  interaction.pasteShift = false;
  // 1) 内部クリップボード (選択範囲のコピー / 切り取り) を優先して新規レイヤーに貼り付け
  if (hasInternal()) {
    pasteAsLayer();
    return;
  }
  // 2) OS クリップボードの画像。Shift なし = 新規レイヤー / Ctrl+Shift+V = ドキュメント差し替え
  const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
  if (!item) return;
  const blob = item.getAsFile();
  if (!blob) return;
  loadImageFromBlob(blob)
    .then((image) => {
      if (asDocument) applyImage(image, "clipboard.png");
      else pasteImageAsLayer(image);
    })
    .catch(() => toast("クリップボードの画像を読み込めませんでした", "info"));
}

/* ---------- ドラッグ & ドロップ ---------- */
let dragDepth = 0;

function onDragEnter(e: DragEvent): void {
  e.preventDefault();
  const hasImage = Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === "file" && i.type.startsWith("image/"));
  if (!hasImage) return;
  dragDepth++;
  $("#workspace").classList.add("is-dragover");
}

function onDragOver(e: DragEvent): void {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
}

function onDragLeave(): void {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("#workspace").classList.remove("is-dragover");
  }
}

function onDrop(e: DragEvent): void {
  e.preventDefault();
  dragDepth = 0;
  $("#workspace").classList.remove("is-dragover");
  const file = Array.from(e.dataTransfer?.files ?? []).find(isImageFile);
  if (!file) {
    toast("画像ファイルをドロップしてください", "info");
    return;
  }
  void handleFile(file);
}

/** 画像入出力の DOM 配線 (起動時に一度だけ呼ぶ) */
export function bindImageIO(): void {
  $("#btn-open").addEventListener("click", openFile);
  $("#btn-save").addEventListener("click", saveComposite);
  $("#btn-copy").addEventListener("click", () => void copyComposite());
  $("#btn-paste").addEventListener("click", () => void pasteFromOsClipboardAsLayer());

  ($("#file-open") as HTMLInputElement).addEventListener("change", (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) void handleFile(file);
  });

  document.addEventListener("paste", onPaste);

  const workspace = $("#workspace");
  workspace.addEventListener("dragenter", onDragEnter);
  workspace.addEventListener("dragover", onDragOver);
  workspace.addEventListener("dragleave", onDragLeave);
  workspace.addEventListener("drop", onDrop);
}

/** ショートカット (Ctrl+S / Ctrl+Shift+C) から呼び出すため公開 */
export const imageIOActions = { saveComposite, copyComposite, openFile };