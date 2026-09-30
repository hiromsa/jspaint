/**
 * core/editorState.ts — エディタのユーザー設定・ビュー状態
 * オブジェクト自体は不変 (プロパティのみ更新) なので、複数モジュールから安全に共有できる。
 */
import type { SelMode, ToolId } from "./types";
import { SIZE_TOOLS } from "./toolDefs";

/** ブラシサイズの上限 (px)。スライダー / [ ] キー / クイックサイズすべての共通クランプ */
export const MAX_BRUSH_SIZE = 500;
/** ブラシサイズの既定値 (px)。index.html のスライダー初期値と一致させる */
export const DEFAULT_BRUSH_SIZE = 24;

/** ツール別サイズの localStorage 保存キー */
const TOOL_SIZE_STORAGE_KEY = "jspaint.toolSizes.v1";

/** ツールごとに記憶したサイズ (ツール切替時に復元する) */
const toolSizes = new Map<ToolId, number>();

/** 1〜MAX_BRUSH_SIZE に丸めてクランプする */
function clampBrushSize(size: number): number {
  return Math.min(MAX_BRUSH_SIZE, Math.max(1, Math.round(size)));
}

/** 起動時に localStorage からツール別サイズを復元する (壊れた値は無視して既定値を使う) */
export function loadToolSizes(): void {
  try {
    const raw = localStorage.getItem(TOOL_SIZE_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return;
    const values = parsed as Record<string, unknown>;
    for (const tool of SIZE_TOOLS) {
      const v = Number(values[tool]);
      if (Number.isFinite(v) && v >= 1) toolSizes.set(tool, clampBrushSize(v));
    }
  } catch {
    // ストレージが使えない環境 / 壊れたデータは既定値で開始する
  }
}

/** ツールに保存されたサイズ (未記録なら既定値) */
export function getToolSize(tool: ToolId): number {
  return toolSizes.get(tool) ?? DEFAULT_BRUSH_SIZE;
}

/**
 * ブラシサイズを更新する (現在のツールへ記憶 + localStorage へ即時保存)。
 * サイズスライダー / クイックサイズ / [ ] キーすべての入口。
 */
export function setBrushSize(size: number): void {
  state.brushSize = clampBrushSize(size);
  if (SIZE_TOOLS.includes(state.tool)) {
    toolSizes.set(state.tool, state.brushSize);
    saveToolSizes();
  }
}

/** ツール切替時に、そのツールで最後に使ったサイズへ復元する */
export function restoreToolSize(tool: ToolId): void {
  if (SIZE_TOOLS.includes(tool)) state.brushSize = getToolSize(tool);
}

function saveToolSizes(): void {
  try {
    const obj: Record<string, number> = {};
    toolSizes.forEach((v, k) => {
      obj[k] = v;
    });
    localStorage.setItem(TOOL_SIZE_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // ストレージ不可の環境ではセッション内の記憶のみ有効
  }
}

export const state = {
  tool: "brush" as ToolId,
  fg: "#2563eb",
  bg: "#ffffff",
  brushSize: DEFAULT_BRUSH_SIZE,
  opacity: 100,
  fillShape: true,
  tolerance: 25,
  /** AI被写体選択の検出しきい値 (%)。saliency map の min-max 正規化値と比較する */
  aiThreshold: 50,
  selMode: "new" as SelMode,
  /** 膨張ブラシの効果方向: 1 = 膨張 / -1 = 収縮 (Alt で一時反転) */
  bloatDir: 1 as 1 | -1,
  /** パペットワープのメッシュ間隔 (px)。セッション中に変更するとメッシュを作り直す */
  puppetSpacing: 32,
  zoom: 1,
  panX: 0,
  panY: 0,
  dirty: false,
  spacePan: false,
};