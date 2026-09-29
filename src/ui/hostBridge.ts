/**
 * ui/hostBridge.ts — ホスト (親フレーム) からの postMessage 受信
 *
 * Forge 拡張 (stable-diffusion-webui-jspaint2) が本ツールを iframe 埋め込み (?mode=embed)
 * で使う際に送る JSPAINT_LOAD を受けて、元画像 + Inpainting マスクでドキュメントを初期化する。
 *
 *   親アプリ → 本ツール (ui/hostBridge.ts):
 *     { type: "JSPAINT_LOAD", image: dataURL, mask?: dataURL, name?: string }
 *   本ツール → 親アプリ (既存・ui/exportModal.ts):
 *     { type: "JSPAINT_EXPORT", compositeImage: dataURL, maskImage: dataURL }
 *
 * mask は「黒 = 描画なし / 白 = 描画あり」の画像を受け取り、白の輝度を不透明度に変換した
 * 白ペイントレイヤー「Inpaintマスク」として追加する (エクスポートのマスク生成は
 * paint レイヤーから行われるため、このレイヤー編集 = マスク編集になる)。
 */
import { applyBaseImage } from "../core/documentOps";
import { doc } from "../core/documentStore";
import { loadImageFromBlob } from "../core/imageSource";
import { markClean, markDirty, toast } from "./feedback";

/** JSPAINT_LOAD メッセージの型 */
interface HostLoadMessage {
  type: "JSPAINT_LOAD";
  /** 元画像 (dataURL) — 必須 */
  image: string;
  /** Inpainting マスク (dataURL / 黒=描画なし, 白=描画あり) — 任意 */
  mask?: string;
  /** ドキュメント名 — 任意 */
  name?: string;
}

/** dataURL を Blob へ変換する (fetch に頼らず確実にデコードする) */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const head = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const mime = /^data:([^;]+)/.exec(head)?.[1] ?? "application/octet-stream";
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function isImageDataURL(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:image/") && value.includes(",");
}

/**
 * 「黒 = 描画なし / 白 = 描画あり」のマスク画像を、白 (255,255,255) の不透明度に
 * 変換した canvas へ詰め替える。輝度 = 不透明度 (半端なエッジも保存される)。
 */
async function maskToPaintCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  const mask = await loadImageFromBlob(dataUrlToBlob(dataUrl));
  const w = mask.width;
  const h = mask.height;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const g = out.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(mask, 0, 0);
  const im = g.getImageData(0, 0, w, h);
  const d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = Math.max(d[i], d[i + 1], d[i + 2]);
    d[i] = 255;
    d[i + 1] = 255;
    d[i + 2] = 255;
    d[i + 3] = lum;
  }
  g.putImageData(im, 0, 0);
  return out;
}

/** 読み込み中のメッセージを無効化するための連番 (後着を優先) */
let loadSeq = 0;

/** ホストからの JSPAINT_LOAD を処理する */
function handleLoadMessage(msg: HostLoadMessage): void {
  if (!isImageDataURL(msg.image)) {
    toast("JSPAINT_LOAD: image が無効です", "info");
    return;
  }
  const seq = ++loadSeq;
  void (async () => {
    try {
      const image = await loadImageFromBlob(dataUrlToBlob(msg.image));
      const name = typeof msg.name === "string" && msg.name ? msg.name : "inpaint.png";
      applyBaseImage(image, name);
      if (isImageDataURL(msg.mask)) {
        const paint = await maskToPaintCanvas(msg.mask);
        // 受け取ったマスクを Inpainting マスクレイヤーとして追加し、マスク指定にする
        // (エクスポート時はこのレイヤーがそのままマスクとして親アプリへ返る)。
        // カレント (アクティブ) にはしない — 開いた直後に画像側を編集できるように
        const layer = doc.addImageLayer(paint, "Inpaintマスク", { active: false });
        doc.setInpaintMaskLayer(layer);
        // カレントを描画対象 (元画像) にしておく
        const base = doc.layers.find((l) => l.kind === "image");
        if (base) doc.selectLayer(base, false);
        markDirty();
        toast(`ホストから画像 + マスクを受信しました (${image.width}×${image.height} · 「${layer.name}」をマスクに指定)`, "ok");
      } else {
        markClean();
        toast(`ホストから画像を受信しました (${image.width}×${image.height})`, "ok");
      }
    } catch (err) {
      console.error("JSPAINT_LOAD failed:", err);
      if (seq === loadSeq) toast("ホストからの画像読み込みに失敗しました", "info");
    }
  })();
}

/** message リスナーを登録する (standalone でも無害 — 親からのメッセージは来ない) */
export function bindHostBridge(): void {
  window.addEventListener("message", (e: MessageEvent) => {
    const data: unknown = e.data;
    if (!data || typeof data !== "object") return;
    const msg = data as Partial<HostLoadMessage> & { type?: unknown };
    if (msg.type !== "JSPAINT_LOAD") return;
    handleLoadMessage(msg as HostLoadMessage);
  });
}