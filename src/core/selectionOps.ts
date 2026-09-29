/**
 * core/selectionOps.ts — 選択範囲に対するドキュメント編集操作
 * 塗りつぶし / 消去 / 全選択 / 解除など、選択ストアとドキュメントストアをまたぐ操作。
 */
import { clone, tintMask } from "./canvasUtils";
import { doc } from "./documentStore";
import { history } from "./historyStack";
import { hooks } from "./hooks";
import { selection } from "./selectionStore";
import { state } from "./editorState";

/** 選択範囲を描画色で塗りつぶし */
export function fillSelection(): void {
  if (!selection.hasSelection) {
    hooks.toast("先に選択範囲を作成してください", "info");
    return;
  }
  const targets = doc.editTargets().filter((l) => l.kind === "paint");
  if (!targets.length) {
    hooks.toast("ペイントレイヤーを編集対象にしてください", "info");
    return;
  }
  history.pushUndo();
  const m = clone(selection.mask);
  tintMask(m, state.fg);
  targets.forEach((l) => {
    l.ctx.save();
    l.ctx.globalAlpha = state.opacity / 100;
    l.ctx.drawImage(m, 0, 0);
    l.ctx.restore();
  });
  hooks.markDirty();
  hooks.render();
  hooks.toast(targets.length > 1 ? `選択範囲を ${targets.length} レイヤーに塗りつぶしました` : "選択範囲を塗りつぶしました", "ok");
}

/** 選択範囲の内容をペイントレイヤーから消去 (Delete) */
export function deleteSelectionContents(): void {
  const targets = doc.editTargets().filter((l) => l.kind === "paint");
  if (!targets.length) {
    hooks.toast("ペイントレイヤーを編集対象にしてください", "info");
    return;
  }
  history.pushUndo();
  targets.forEach((l) => {
    l.ctx.save();
    l.ctx.globalCompositeOperation = "destination-out";
    l.ctx.drawImage(selection.mask, 0, 0);
    l.ctx.restore();
  });
  hooks.markDirty();
  hooks.render();
}

/** 選択解除 (Ctrl+D) */
export function deselect(): void {
  if (!selection.hasSelection) return;
  selection.clearSelection();
  hooks.toast("選択を解除しました", "info");
}

/** キャンバス全体を選択 (Ctrl+A) */
export function selectAll(): void {
  selection.applySelection((g) => g.fillRect(0, 0, doc.width, doc.height), "new");
  hooks.toast("キャンバス全体を選択", "info");
}