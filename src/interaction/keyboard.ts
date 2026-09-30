/**
 * interaction/keyboard.ts — キーボードショートカット
 * UI (パネル / モーダル) 側の操作は deps として受け取る (Step 4 で直接 import に置き換え)。
 */
import { $ } from "../ui/dom";
import { setBrushSize, state } from "../core/editorState";
import { hooks } from "../core/hooks";
import { interaction } from "../core/interactionState";
import { selection } from "../core/selectionStore";
import { history } from "../core/historyStack";
import { samSelect } from "../ai/samController";
import { deleteSelectionContents, deselect, fillSelection, selectAll } from "../core/selectionOps";
import { copySelection, cutSelection } from "../core/clipboard";
import { fitView, setZoom } from "../core/viewState";
import { KEY_TOOL, TOOLS } from "../core/toolDefs";
import { cancelPolygon, closePolygon } from "./pointer";
import { setTool, syncSlider, swapColors, closeAiModelSetup } from "../ui/panels";
import { closeExport, openExport } from "../ui/exportModal";
import { imageIOActions } from "../ui/imageIO";
import { hostMode } from "../ui/hostMode";
import { warpSession } from "../puppet/warpSession";

/** window へ keydown / keyup を配線する */
export function bindKeyboard(): void {
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
}

function onKeyDown(e: KeyboardEvent): void {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.key === "Alt") interaction.altKey = true;
  const k = e.key.toLowerCase();

  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); if (e.shiftKey) history.redo(); else history.undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); history.redo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "a") { e.preventDefault(); selectAll(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "d") { e.preventDefault(); deselect(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "c") { e.preventDefault(); copySelection(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "x") { e.preventDefault(); cutSelection(); return; }
  // Ctrl+V (貼り付け) は paste イベントで処理する。Shift の有無 (Ctrl+Shift+V = ドキュメント差し替え) を記録
  if ((e.ctrlKey || e.metaKey) && k === "v") { interaction.pasteShift = e.shiftKey; return; }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); openExport(); return; }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "c") { e.preventDefault(); imageIOActions.copyComposite(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "s") {
    e.preventDefault();
    // 保存は standalone モード専用。embed (親アプリ埋め込み) では「完了」で親へ返す
    if (hostMode === "standalone") imageIOActions.saveComposite();
    else hooks.toast("埋め込みモードでは「完了 (Ctrl+Enter)」で親アプリへ返してください", "info");
    return;
  }
  if (e.altKey && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); fillSelection(); return; }

  if (e.key === " ") { e.preventDefault(); state.spacePan = true; $("#stage").style.cursor = "grab"; return; }
  if (e.key === "Escape") {
    if (!($("#modal-export") as HTMLElement).hidden) { closeExport(); return; }
    // AIモデルセットアップモーダル (ダウンロード元の案内)
    if (!($("#modal-ai-model") as HTMLElement).hidden) { closeAiModelSetup(); return; }
    // SAM囲み選択のドラッグ中断 → ポイントクリア (選択範囲は維持)
    if (samSelect.isDragging) { samSelect.cancelDrag(); return; }
    if (samSelect.hasPoints) { samSelect.resetPoints(true); return; }
    // パペットワープセッションの取消 (進行中の変形を破棄)
    if (warpSession.active) { warpSession.cancel(); return; }
    if (interaction.polyDrag || interaction.polyPoints.length > 0) { cancelPolygon(); return; }
    if (interaction.lassoPath) { interaction.lassoPath = null; hooks.render(); hooks.toast("投げ縄選択を取消", "info"); return; }
    if (interaction.preview || interaction.dragStart) { interaction.preview = null; interaction.dragStart = null; hooks.render(); return; }
    // 選択範囲をクリア
    if (selection.hasSelection) deselect();
    return;
  }
  if (e.key === "Enter" && warpSession.active) { e.preventDefault(); warpSession.commit(); return; }
  // SAMポイントの確定 (選択範囲は既に反映済み。ポイント指定を終了する)
  if (e.key === "Enter" && samSelect.hasPoints) { samSelect.resetPoints(true); return; }
  if (e.key === "Enter" && state.tool === "polygon") { closePolygon(); return; }
  if (e.key === "Delete" && selection.hasSelection) {
    deleteSelectionContents();
    return;
  }

  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (KEY_TOOL[k]) { setTool(KEY_TOOL[k]); return; }
  if (k === "x") { swapColors(); return; }
  if (k === "[") { setBrushSize(state.brushSize - Math.max(1, Math.round(state.brushSize * 0.15))); syncSlider(); return; }
  if (k === "]") { setBrushSize(state.brushSize + Math.max(1, Math.round(state.brushSize * 0.15))); syncSlider(); return; }
  if (e.key === "+" || e.key === "=") { setZoom(state.zoom * 1.25); return; }
  if (e.key === "-") { setZoom(state.zoom / 1.25); return; }
  if (e.key === "0") { setZoom(1); return; }
  if (e.key === "1") { fitView(); return; }
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.key === "Alt") interaction.altKey = false;
  if (e.key === " ") {
    state.spacePan = false;
    $("#stage").style.cursor = TOOLS[state.tool].cursor;
  }
}