/**
 * core/documentOps.ts — ドキュメントに対する複合操作
 * 複数のストア (doc / selection / history / filters) をまたぐ一連の手順を担う。
 */
import { doc } from "./documentStore";
import { filters } from "./filterEngine";
import { history } from "./historyStack";
import { hooks } from "./hooks";
import { selection } from "./selectionStore";
import { fitView } from "./viewState";

/**
 * 画像を新しいベース (元画像) としてドキュメントへ適用する。
 * ドキュメントサイズは読み込み画像に合わせて変わり、選択範囲・Undo/Redo・
 * フィルター設定はリセットされる (異なるサイズのスナップショット混在を防ぐため)。
 * 進行中の編集セッション (多角形 / パペットワープ) の取消は UI 層で行うこと。
 */
export function applyBaseImage(image: HTMLCanvasElement, name?: string): void {
  selection.resizeTo(image.width, image.height);
  history.clear();
  filters.resetValues();
  filters.onDocResized();
  doc.replaceBaseImage(image, name);
  fitView();
  hooks.syncDocInfo();
  hooks.renderLayers();
  hooks.render();
}