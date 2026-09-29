/**
 * core/types.ts — JSPaint 全体で共有する型とドキュメント定数
 * core (ロジック) / rendering / painting / interaction / ui のどこから参照してよい。
 * このファイル自身はどのモジュールにも依存しない。
 */

/** ドキュメント (ステージ) の解像度 */
export const DOC_W = 640;
export const DOC_H = 640;

/** ツール ID (ツールボックスの全ボタンと 1:1 対応) */
export type ToolId =
  | "brush" | "eraser" | "bucket"
  | "smudge" | "bloat" | "dodge" | "burn" | "filter-pen"
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

/** レイヤー */
export interface Layer {
  id: number;
  name: string;
  kind: "base" | "paint";
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  visible: boolean;
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
}