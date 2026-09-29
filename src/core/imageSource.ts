/**
 * core/imageSource.ts — 画像ソースの読み込み (File / Blob → canvas)
 * UI に依存しない純粋な変換処理。デコード結果はドキュメント実寸の canvas になる。
 */

/** 画像として扱えるファイルか */
export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/** File / Blob をデコードして canvas 化する */
export async function loadImageFromBlob(blob: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("画像のデコードに失敗しました"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, img.naturalWidth);
    canvas.height = Math.max(1, img.naturalHeight);
    canvas.getContext("2d")!.drawImage(img, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** ファイルを読み込んで canvas 化する */
export function loadImageFromFile(file: File): Promise<HTMLCanvasElement> {
  return loadImageFromBlob(file);
}