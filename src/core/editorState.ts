/**
 * core/editorState.ts — エディタのユーザー設定・ビュー状態
 * オブジェクト自体は不変 (プロパティのみ更新) なので、複数モジュールから安全に共有できる。
 */
import type { SelMode, ToolId } from "./types";

export const state = {
  tool: "brush" as ToolId,
  fg: "#2563eb",
  bg: "#ffffff",
  brushSize: 24,
  opacity: 100,
  fillShape: true,
  tolerance: 25,
  selMode: "new" as SelMode,
  /** 膨張ブラシの効果方向: 1 = 膨張 / -1 = 収縮 (Alt で一時反転) */
  bloatDir: 1 as 1 | -1,
  zoom: 1,
  panX: 0,
  panY: 0,
  dirty: false,
  spacePan: false,
};