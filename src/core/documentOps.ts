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
 * 画像を新しいドキュメント (元画像レイヤー) として読み込む。
 * ドキュメントサイズは読み込み画像に合わせて変わり、選択範囲・Undo/Redo・
 * フィルター設定はリセットされる (異なるサイズのスナップショット混在を防ぐため)。
 * 進行中の編集セッション (多角形 / パペットワープ) の取消は UI 層で行うこと。
 */
export function applyBaseImage(image: HTMLCanvasElement, name?: string): void {
  selection.resizeTo(image.width, image.height);
  history.clear();
  filters.resetValues();
  filters.onDocResized();
  doc.loadAsDocument(image, name);
  fitView();
  hooks.syncDocInfo();
  hooks.renderLayers();
  hooks.render();
}

/**
 * ドキュメントを読み込み直後の状態へ戻す (キャンセル処理)。
 * レイヤー構成・ピクセルを初期状態に復元し、選択・履歴・フィルターをリセットする。
 */
export function resetDocument(): void {
  doc.resetToInitial();
  selection.resizeTo(doc.width, doc.height);
  history.clear();
  filters.resetValues();
  filters.onDocResized();
  fitView();
  hooks.syncDocInfo();
  hooks.renderLayers();
  hooks.render();
}