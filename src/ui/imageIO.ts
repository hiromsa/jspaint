/**
 * ui/imageIO.ts — 画像の入出力 (開く / 保存 / クリップボード / ドラッグ&ドロップ / ペースト)
 * 読み込んだ画像は core/documentOps.applyBaseImage 経由で「新しいベース画像」として
 * ドキュメントに適用する (ドキュメントサイズは画像に追従)。
 * ファイルを開く / 保存は standalone モード専用 (ui/hostMode.ts で UI を切り替え)。
 */
import { applyBaseImage } from "../core/documentOps";
import { doc } from "../core/documentStore";
import { isImageFile, loadImageFromBlob, loadImageFromFile } from "../core/imageSource";
import { cancelPolygon } from "../interaction/pointer";
import { warpSession } from "../puppet/warpSession";
import { downloadDataUrl } from "./exportModal";
import { $ } from "./dom";
import { markClean, toast } from "./feedback";

/** 進行中の編集セッションを取り消してから画像をベースとして適用する */
function applyImage(image: HTMLCanvasElement, name?: string): void {
  cancelPolygon();
  if (warpSession.active) warpSession.cancel();
  applyBaseImage(image, name);
  markClean();
  toast(`${name ?? "画像"} (${image.width}×${image.height}) を読み込みました`, "ok");
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

/** 合成画像 (背景フィルター + 全レイヤー) を PNG ファイルへ保存 (standalone モード専用) */
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

/* ---------- ペースト (Ctrl+V) ---------- */
function onPaste(e: ClipboardEvent): void {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
  if (!item) return;
  const blob = item.getAsFile();
  if (!blob) return;
  e.preventDefault();
  loadImageFromBlob(blob)
    .then((image) => applyImage(image, "clipboard.png"))
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