/**
 * core/hooks.ts — UI 層へのコールバック窓口
 * core (ロジック) は ui/ を import できないため、ここに登録された実装を通じてだけ
 * 描画 / Toast / パネル同期などの UI 更新を依頼する。実装は startApp() で差し込む。
 */
import type { EditorHooks } from "./types";

export const hooks: EditorHooks = {
  render: () => {},
  toast: () => {},
  markDirty: () => {},
  syncToolGuide: () => {},
  renderLayers: () => {},
  updateUndoButtons: () => {},
  syncFilterUI: () => {},
  syncZoomUI: () => {},
};

/** アプリ起動時に UI 実装へ差し替える */
export function setHooks(impl: EditorHooks): void {
  Object.assign(hooks, impl);
}