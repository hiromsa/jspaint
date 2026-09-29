/**
 * core/types.ts — JSPaint 全体で共有する型とドキュメント定数
 * core (ロジック) / rendering / painting / interaction / ui のどこから参照してよい。
 * このファイル自身はどのモジュールにも依存しない。
 */

/**
 * 既定の初期ドキュメントサイズ (デモ画像生成に使用)。
 * ドキュメント自体は可変 — 実寸は DocumentStore の width / height を参照すること。
 */
export const DOC_W = 640;
export const DOC_H = 640;

/** ツール ID (ツールボックスの全ボタンと 1:1 対応) */
export type ToolId =
  | "brush" | "eraser" | "bucket"
  | "smudge" | "bloat" | "puppet-warp" | "dodge" | "burn" | "filter-pen"
  | "line" | "rect" | "ellipse"
  | "select-rect" | "lasso" | "polygon" | "wand" | "mask-pen"
  | "eyedropper" | "pan";

/** 選択合成モード: 新規 / 追加 (Shift) / 除外 (Alt) */
export type SelMode = "new" | "add" | "sub";

/** Toast の表示種別 */
export type ToastKind = "info" | "ok" | "fx";

/** ドキュメント座標 (ピクセル) */
export interface Pt {
  x: number;
  y: number;
}

/** ドキュメント座標上の矩形 (図形 / 選択のドラッグ中プレビュー) */
export interface StrokePreview {
  tool: ToolId;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * レイヤー。
 * kind:
 *   - "image": 元画像レイヤー (画像読み込みで生成)。通常レイヤーと同様に編集・削除可能。
 *              Inpainting マスクの生成対象には含めない (元画像は白化しない)。
 *   - "paint": 描画レイヤー。Inpainting マスクの生成対象になる。
 * locked: ロック中は描画・フィルターの適用対象から除外される (表示は通常どおり)。
 */
export interface Layer {
  id: number;
  name: string;
  kind: "image" | "paint";
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  visible: boolean;
  locked: boolean;
}

/**
 * UI 層へのコールバック窓口。
 * core (ロジック) から ui/ を import しないための境界。
 * 実装は startApp() で setHooks() により差し込まれる (既定は no-op)。
 */
export interface EditorHooks {
  render(): void;
  toast(msg: string, kind?: ToastKind): void;
  markDirty(): void;
  syncToolGuide(): void;
  renderLayers(): void;
  updateUndoButtons(): void;
  syncFilterUI(): void;
  syncZoomUI(): void;
  /** ヘッダー等のドキュメント情報 (ファイル名 / サイズ) を UI へ反映 */
  syncDocInfo(): void;
}