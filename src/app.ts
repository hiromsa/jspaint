/**
 * app.ts — JSPaint アプリのエントリポイント (生成と配線のみ)
 * Photoshop/Figma ライクな Inpainting 前処理ペイントの動作デモ。
 *
 * アーキテクチャ:
 *   core/       ドメインロジック (ストア・フィルター・選択・Undo・ビュー変換)
 *   painting/   描画系ツールの実装
 *   rendering/  キャンバスへの描画
 *   interaction/ ポインタ・キーボード入力
 *   ui/         DOM 配線 (パネル・レイヤー・フィルター・エクスポート)
 * このファイルは各モジュールの生成と結線だけを行う。core から UI への
 * 更新要求は hooks (core/hooks.ts) 経由でここに差し込まれた実装へ流れる。
 */
import { mountIcons } from "./assets/icons";
import { createDemoImage } from "./assets/demo";
import { loadToolSizes, state } from "./core/editorState";
import { doc } from "./core/documentStore";
import { selection } from "./core/selectionStore";
import { history } from "./core/historyStack";
import { setHooks } from "./core/hooks";
import { fitView } from "./core/viewState";
import { render, resizeView } from "./rendering/renderer";
import { bindCanvasEvents } from "./interaction/pointer";
import { bindKeyboard } from "./interaction/keyboard";
import {
  bindControls,
  bindTabs,
  setTool,
  syncBrushPreview,
  syncToolGuide,
  updateColorUI,
} from "./ui/panels";
import { bindLayers, renderLayers } from "./ui/layersPanel";
import { bindFilters, syncFilterUI } from "./ui/filtersPanel";
import { bindHeaderAndModal } from "./ui/exportModal";
import { bindImageIO } from "./ui/imageIO";
import { bindHostBridge } from "./ui/hostBridge";
import { applyHostModeUI } from "./ui/hostMode";
import { $ } from "./ui/dom";
import { markDirty, toast } from "./ui/feedback";

const workspace = $("#workspace");

function updateUndoButtons(): void {
  ($("#btn-undo") as HTMLButtonElement).disabled = !history.canUndo;
  ($("#btn-redo") as HTMLButtonElement).disabled = !history.canRedo;
}

/** ヘッダー / ワークスペースのドキュメント情報 (ファイル名・サイズ) を更新 */
function syncDocInfo(): void {
  $("#doc-name").textContent = doc.name;
  $("#doc-dim").textContent = `${doc.width}×${doc.height}`;
  $("#ws-size").textContent = `${doc.width} × ${doc.height}`;
}

/* ============ 座標変換 / ズーム → core/viewState.ts へ分離 ============ */
function syncZoomUI(): void {
  const pct = `${Math.round(state.zoom * 100)}%`;
  $("#btn-zoom-label").textContent = pct;
  $("#ws-zoom").textContent = pct;
  $("#st-zoom").textContent = pct;
}

/* ============ エントリポイント ============ */
export function startApp(): void {
  mountIcons();

  // ホストモード (standalone / embed) を判定して standalone 専用 UI の表示を切り替える
  applyHostModeUI();

  // core からの UI 更新は hooks 経由で行う (実装をここで差し込む)
  setHooks({ render, toast, markDirty, syncToolGuide, renderLayers, updateUndoButtons, syncFilterUI, syncZoomUI, syncDocInfo });
  // localStorage のツール別サイズを setTool("brush") より前に復元する
  loadToolSizes();
  doc.init(createDemoImage());
  // 起動直後 (デモ画像をそのまま編集するケース) も選択マスクを実寸へ合わせる。
  // resizeTo は画像読み込み (documentOps.applyBaseImage) 時にしか呼ばれないと、
  // デモ画像上での選択が 1x1 マスクに限定され、Marching Ants も表示されない
  selection.resizeTo(doc.width, doc.height);

  resizeView();
  fitView();
  renderLayers();
  updateUndoButtons();
  updateColorUI();
  syncBrushPreview();
  syncFilterUI();
  setTool("brush");
  selection.startAntLoop();

  bindCanvasEvents();
  window.addEventListener("resize", resizeView);
  new ResizeObserver(resizeView).observe(workspace);
  bindKeyboard();
  bindControls();
  bindTabs();
  bindFilters();
  bindLayers();
  bindHeaderAndModal();
  bindImageIO();
  // ホスト (親フレーム) からの JSPAINT_LOAD を受信する (Forge 拡張との連携)
  bindHostBridge();
}
