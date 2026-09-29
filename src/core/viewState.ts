/**
 * core/viewState.ts — ビューポートとズーム / パン / 座標変換
 */
import { doc } from "./documentStore";
import { state } from "./editorState";
import { hooks } from "./hooks";
import type { Pt } from "./types";

/** ワークスペースのビューポート (CSS px)。renderer の resizeView() が更新する */
export const viewport = {
  vw: 0,
  vh: 0,
  /** 描画解像度の倍率 (高DPI対応・最大2に制限) */
  dpr: Math.min(window.devicePixelRatio || 1, 2),
};

/**
 * 画面(CSS px)⇔ドキュメント座標の相互変換。
 * render() と同じ「ドキュメント中心基準」の写像を使うこと(ズレ防止)。
 *   screen = vw/2 + pan + (doc − DOC中心) × zoom
 */
export function screenToDoc(sx: number, sy: number): Pt {
  return {
    x: (sx - viewport.vw / 2 - state.panX) / state.zoom + doc.width / 2,
    y: (sy - viewport.vh / 2 - state.panY) / state.zoom + doc.height / 2,
  };
}

export function docToScreenX(dx: number): number {
  return viewport.vw / 2 + state.panX + (dx - doc.width / 2) * state.zoom;
}

export function docToScreenY(dy: number): number {
  return viewport.vh / 2 + state.panY + (dy - doc.height / 2) * state.zoom;
}

/** ズーム倍率を変更する (cx / cy = 中心に置く画面座標・省略時はビュー中央) */
export function setZoom(z: number, cx?: number, cy?: number): void {
  const nz = Math.min(8, Math.max(0.05, z));
  const px = cx ?? viewport.vw / 2;
  const py = cy ?? viewport.vh / 2;
  const dx = (px - viewport.vw / 2 - state.panX) / state.zoom;
  const dy = (py - viewport.vh / 2 - state.panY) / state.zoom;
  state.zoom = nz;
  state.panX = px - viewport.vw / 2 - dx * nz;
  state.panY = py - viewport.vh / 2 - dy * nz;
  hooks.syncZoomUI();
  hooks.render();
}

/** ドキュメント全体をワークスペースに収める */
export function fitView(): void {
  state.zoom = Math.min((viewport.vw - 56) / doc.width, (viewport.vh - 56) / doc.height);
  state.panX = 0;
  state.panY = 0;
  hooks.syncZoomUI();
  hooks.render();
}