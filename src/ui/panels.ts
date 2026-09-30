/**
 * ui/panels.ts — ツールボックス / パラメータパネル / カラー / タブの配線と同期
 * ロジックは持たず、core のストアを呼び出して DOM を更新する。
 */
import { mountIcons } from "../assets/icons";
import { doc } from "../core/documentStore";
import { MAX_BRUSH_SIZE, restoreToolSize, setBrushSize, state } from "../core/editorState";
import { selection } from "../core/selectionStore";
import { PAINT_TOOLS, TOOLS, TOOL_ICON } from "../core/toolDefs";
import type { SelMode, ToolId } from "../core/types";
import { render } from "../rendering/renderer";
import { warpSession } from "../puppet/warpSession";
import { deselect, fillSelection, selectAll } from "../core/selectionOps";
import { $, $$, paintRangeFill } from "./dom";
import { toast } from "./feedback";

const stage = $("#stage");

/** ツールスタック (階層ボタン) のメイン表示を選択中ツールに追従させる */
export function syncToolStackDisplay(tool: ToolId): void {
  document.querySelectorAll<HTMLElement>(".toolstack").forEach((stack) => {
    const members = (stack.dataset.stack ?? "").split(",");
    if (!members.includes(tool)) return;
    const main = stack.querySelector<HTMLElement>(":scope > .toolbtn");
    if (!main) return;
    main.dataset.tool = tool;
    const info = TOOLS[tool];
    main.title = `${info.label} (${info.key}) — 右クリック / ▶ で切替`;
    const cur = main.querySelector("i[data-icon]");
    if (cur) {
      const holder = document.createElement("span");
      holder.innerHTML = `<i data-icon="${TOOL_ICON[tool]}"></i>`;
      cur.replaceWith(holder.firstElementChild!);
    } else {
      main.innerHTML = `<i data-icon="${TOOL_ICON[tool]}"></i>`;
    }
    mountIcons(main);
  });
}

/** ステータスバーの操作ガイドを更新 (選択中は「範囲内のみ」・複数対象時は「N レイヤーに適用」注記を添える) */
export function syncToolGuide(): void {
  const selNote = selection.hasSelection && PAINT_TOOLS.includes(state.tool) ? " · 選択範囲内のみ描画" : "";
  const targets = doc.editTargets().length;
  const multiNote = PAINT_TOOLS.includes(state.tool) && targets > 1 ? ` · 編集対象 ${targets} レイヤーに適用` : "";
  $("#st-guide").textContent = TOOLS[state.tool].guide + selNote + multiNote;
}

export function setTool(tool: ToolId): void {
  // パペットワープセッションの引継ぎ (puppet-warp に切り替えたら開始 / 離脱時は自動確定)
  warpSession.handleToolChange(tool);
  state.tool = tool;
  // ツール別サイズを復元 (サイズUIを持たないツールでは現在値を維持)
  restoreToolSize(tool);
  $$(".toolbtn").forEach((b) => b.classList.toggle("is-active", b.dataset.tool === tool));
  const info = TOOLS[tool];
  $("#tool-title").textContent = info.label;
  $("#tool-shortcut").textContent = info.key;
  syncToolGuide();
  const chip = $("#st-tool");
  chip.innerHTML = `<i data-icon="${TOOL_ICON[tool]}"></i><b>${info.label}</b>`;
  mountIcons(chip);
  stage.style.cursor = info.cursor;
  $("#tol-label").textContent = tool === "wand" ? "類似色の許容度" : "許容度";
  const opLabel = $("#opacity-label");
  opLabel.textContent = tool === "smudge" ? "強さ (にじみ)" : tool === "bloat" ? "強さ (膨張)" : tool === "dodge" || tool === "burn" ? "強さ (露出)" : tool === "filter-pen" ? "適用の強さ" : "不透明度";
  syncToolStackDisplay(tool);
  $$("[data-show]").forEach((el) => {
    const list = (el.dataset.show ?? "").split(",");
    el.classList.toggle("is-hidden", !list.includes(tool));
  });
  // 復元したツール別サイズをスライダー / クイックサイズ / プレビュー円へ反映
  syncSlider();
  render();
}

export function syncBrushPreview(): void {
  const d = $("#brush-dot");
  const max = 52;
  const size = Math.max(3, Math.min(max, state.brushSize));
  d.style.width = `${size}px`;
  d.style.height = `${size}px`;
  $("#brush-preview-label").textContent = `⌀ ${state.brushSize} px`;
  $("#ctl-size-val").textContent = `${state.brushSize} px`;
}

export function updateColorUI(): void {
  const fg = $("#swatch-fg") as HTMLButtonElement;
  const bg = $("#swatch-bg") as HTMLButtonElement;
  fg.style.background = state.fg;
  bg.style.background = state.bg;
  ($("#color-input") as HTMLInputElement).value = state.fg;
}

export function swapColors(): void {
  [state.fg, state.bg] = [state.bg, state.fg];
  updateColorUI();
  toast(`描画色: ${state.fg.toUpperCase()}`, "info");
}

export function syncSlider(): void {
  const el = $("#ctl-size") as HTMLInputElement;
  // スライダー上限は core の定数と同期させる (HTML 初期値の不整合を起動時に吸収)
  el.max = String(MAX_BRUSH_SIZE);
  el.value = String(state.brushSize);
  paintRangeFill(el);
  $$(".chip[data-size]").forEach((c) =>
    c.classList.toggle("is-active", Number((c as HTMLElement).dataset.size) === state.brushSize),
  );
  syncBrushPreview();
  render();
}

export function bindControls(): void {
  // ツールボタン
  $$(".toolbtn").forEach((btn) =>
    btn.addEventListener("click", () => setTool(btn.dataset.tool as ToolId)),
  );

  // ツールスタック (階層ボタン) — ▶ / 右クリックでサブメニューを開閉
  $$(".toolstack").forEach((stack) => {
    const main = stack.querySelector<HTMLElement>(":scope > .toolbtn");
    const caret = stack.querySelector<HTMLElement>(":scope > .toolstack__caret");
    const pop = stack.querySelector<HTMLElement>(":scope > .toolstack__pop");
    if (!main || !caret || !pop) return;
    caret.addEventListener("click", (e) => {
      e.stopPropagation();
      pop.hidden = !pop.hidden;
    });
    main.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      pop.hidden = false;
    });
    pop.addEventListener("contextmenu", (e) => e.preventDefault());
  });
  document.addEventListener("click", () => {
    $$(".toolstack__pop").forEach((p) => (p.hidden = true));
  });

  // スライダー (fill更新共通)
  $$('input[type="range"]').forEach((el) => {
    const input = el as HTMLInputElement;
    paintRangeFill(input);
    input.addEventListener("input", () => paintRangeFill(input));
  });

  // サイズ / 不透明度 / 許容度
  ($("#ctl-size") as HTMLInputElement).addEventListener("input", (e) => {
    setBrushSize(Number((e.target as HTMLInputElement).value));
    syncBrushPreview();
    $$(".chip[data-size]").forEach((c) => c.classList.toggle("is-active", Number((c as HTMLElement).dataset.size) === state.brushSize));
    render();
  });
  ($("#ctl-opacity") as HTMLInputElement).addEventListener("input", (e) => {
    state.opacity = Number((e.target as HTMLInputElement).value);
    $("#ctl-opacity-val").textContent = `${state.opacity} %`;
  });
  ($("#ctl-tolerance") as HTMLInputElement).addEventListener("input", (e) => {
    state.tolerance = Number((e.target as HTMLInputElement).value);
    $("#ctl-tolerance-val").textContent = String(state.tolerance);
  });

  // クイックサイズ
  $$(".chip[data-size]").forEach((chip) =>
    chip.addEventListener("click", () => {
      setBrushSize(Number((chip as HTMLElement).dataset.size));
      ($("#ctl-size") as HTMLInputElement).value = String(state.brushSize);
      paintRangeFill($("#ctl-size") as HTMLInputElement);
      $$(".chip[data-size]").forEach((c) => c.classList.toggle("is-active", c === chip));
      syncBrushPreview();
      render();
    }),
  );

  // 図形塗りつぶし
  ($("#ctl-fill") as HTMLInputElement).addEventListener("change", (e) => {
    state.fillShape = (e.target as HTMLInputElement).checked;
  });

  // 選択合成モード (data-selmode 持つボタンのみ。他セグメントの is-active を壊さないよう絞り込み)
  $$(".seg__btn[data-selmode]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.selMode = (btn as HTMLElement).dataset.selmode as SelMode;
      $$(".seg__btn[data-selmode]").forEach((b) => b.classList.toggle("is-active", b === btn));
    }),
  );

  // 膨張ブラシの効果方向 (膨張 / 収縮)
  $$(".seg__btn[data-bloat-dir]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.bloatDir = Number((btn as HTMLElement).dataset.bloatDir) === -1 ? -1 : 1;
      $$(".seg__btn[data-bloat-dir]").forEach((b) => b.classList.toggle("is-active", b === btn));
    }),
  );

  // パペットワープ (メッシュ間隔 / 確定 / 取消)
  ($("#ctl-mesh") as HTMLInputElement).addEventListener("input", (e) => {
    state.puppetSpacing = Number((e.target as HTMLInputElement).value);
    $("#ctl-mesh-val").textContent = `${state.puppetSpacing} px`;
    warpSession.rebuildMesh();
  });
  $("#btn-warp-apply").addEventListener("click", () => warpSession.commit());
  $("#btn-warp-cancel").addEventListener("click", () => warpSession.cancel());

  // すべて選択
  $("#btn-select-all").addEventListener("click", selectAll);

  // 選択範囲の塗りつぶし / 解除
  $("#btn-fill-selection").addEventListener("click", fillSelection);
  $("#btn-deselect").addEventListener("click", deselect);

  // カラー
  $("#swatch-fg").addEventListener("click", () => ($("#color-input") as HTMLInputElement).click());
  $("#swatch-bg").addEventListener("click", () => ($("#color-input") as HTMLInputElement).click());
  ($("#color-input") as HTMLInputElement).addEventListener("input", (e) => {
    state.fg = (e.target as HTMLInputElement).value;
    $("#swatch-fg").style.background = state.fg;
    render();
  });
  $("#btn-swap-colors").addEventListener("click", swapColors);
}

export function bindTabs(): void {
  $$(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      const name = (tab as HTMLElement).dataset.tab;
      $$(".tab").forEach((t) => t.classList.toggle("is-active", t === tab));
      $$(".panel").forEach((p) => p.classList.toggle("is-active", p.id === `panel-${name}`));
    }),
  );
}