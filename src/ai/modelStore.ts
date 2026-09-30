/**
 * ai/modelStore.ts — AIモデル (.onnx) の IndexedDB キャッシュ
 *
 * モデルファイルは初回のみユーザーが読み込み、以降はキャッシュから起動する。
 * file:// などで IndexedDB が使えない / 容量オーバーの場合はメモリ内キャッシュへ
 * フォールバックする (その場合はタブを閉じると再読み込みが必要)。
 */
import { hooks } from "../core/hooks";

const DB_NAME = "jspaint.ai";
const DB_VERSION = 1;
const STORE_MODELS = "models";

/** SlimSAM エンコーダ (vision_encoder.onnx 約23MB) のキャッシュキー */
export const SLIMSAM_ENCODER_KEY = "slimsam-encoder";
/** SlimSAM デコーダ (prompt_encoder_mask_decoder.onnx 約16MB) のキャッシュキー */
export const SLIMSAM_DECODER_KEY = "slimsam-decoder";

/** IndexedDB 不可環境向けのセッション内キャッシュ */
const memoryCache = new Map<string, ArrayBuffer>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_MODELS)) req.result.createObjectStore(STORE_MODELS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_MODELS, mode);
        const req = run(tx.objectStore(STORE_MODELS));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
        tx.oncomplete = () => db.close();
      }),
  );
}

/** キャッシュ済みモデルの取得 (なければ null。IndexedDB 失敗時はメモリを確認) */
export async function loadModel(key: string): Promise<ArrayBuffer | null> {
  try {
    const cached = await withStore<ArrayBuffer | undefined>("readonly", (s) => s.get(key) as IDBRequest<ArrayBuffer | undefined>);
    if (cached) return cached;
  } catch {
    // IndexedDB が使えない環境はメモリキャッシュのみ
  }
  return memoryCache.get(key) ?? null;
}

/** モデルをキャッシュへ保存する (容量不足等は false を返す — アプリは継続できる) */
export async function saveModel(key: string, buf: ArrayBuffer): Promise<boolean> {
  memoryCache.set(key, buf);
  try {
    await withStore("readwrite", (s) => s.put(buf, key) as IDBRequest<IDBValidKey>);
    return true;
  } catch (e) {
    hooks.toast("モデルをキャッシュできませんでした (次回の起動時に再度読み込みが必要です)", "info");
    if (e instanceof Error) console.warn("[ai] model cache failed:", e.message);
    return false;
  }
}

/** キャッシュしたモデルを削除する */
export async function removeModel(key: string): Promise<void> {
  memoryCache.delete(key);
  try {
    await withStore("readwrite", (s) => s.delete(key) as IDBRequest<undefined>);
  } catch {
    // 使えない環境ではメモリ解放のみで成立
  }
}
