/**
 * app.ts — JSPaint UI モック本体
 * Photoshop/Figma ライクな Inpainting 前処理ペイントの動作デモ。
 *
 * リファクタリング進行中: 型 / 定義 / ストア / 描画 / ツール / 入力は
 * core/ rendering/ painting/ interaction/ へ分離済み (UI 配線は後続ステップで分割)。
 */
import { mountIcons } from "./assets/icons";
import { createDemoImage } from "./assets/demo";
import { DOC_H, DOC_W } from "./core/types";
import type { Layer, SelMode, ToolId } from "./core/types";
import { state } from "./core/editorState";
import { PAINT_TOOLS, TOOLS, TOOL_ICON } from "./core/toolDefs";
import { doc } from "./core/documentStore";
import { selection } from "./core/selectionStore";
import { history } from "./core/historyStack";
import { filters } from "./core/filterEngine";
import { setHooks } from "./core/hooks";
import { fitView, setZoom } from "./core/viewState";
import { deselect, fillSelection, selectAll } from "./core/selectionOps";
import { $, $$ } from "./ui/dom";
import { markDirty, toast } from "./ui/feedback";
import { render, resizeView } from "./rendering/renderer";
import { bindCanvasEvents, cancelPolygon } from "./interaction/pointer";
import { bindKeyboard } from "./interaction/keyboard";

/* ============ DOM ============ */
const stage = $("#stage");
const workspace = $("#workspace");

function updateUndoButtons(): void {
  ($("#btn-undo") as HTMLButtonElement).disabled = !history.canUndo;
  ($("#btn-redo") as HTMLButtonElement).disabled = !history.canRedo;
}

/* ============ 座標変換 / ズーム → core/viewState.ts へ分離 ============ */
function syncZoomUI(): void {
  const pct = `${Math.round(state.zoom * 100)}%`;
  $("#btn-zoom-label").textContent = pct;
  $("#ws-zoom").textContent = pct;
  $("#st-zoom").textContent = pct;
}

/* ============ UI配線: ツール / パネル ============ */

/** ツールスタック (階層ボタン) のメイン表示を選択中ツールに追従させる */
function syncToolStackDisplay(tool: ToolId): void {
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
function syncToolGuide(): void {
  const selNote = selection.hasSelection && PAINT_TOOLS.includes(state.tool) ? " · 選択範囲内のみ描画" : "";
  const targets = doc.editTargets().length;
  const multiNote = PAINT_TOOLS.includes(state.tool) && targets > 1 ? ` · 編集対象 ${targets} レイヤーに適用` : "";
  $("#st-guide").textContent = TOOLS[state.tool].guide + selNote + multiNote;
}

function setTool(tool: ToolId): void {
  state.tool = tool;
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
  render();
}

function paintRangeFill(el: HTMLInputElement): void {
  const min = Number(el.min);
  const max = Number(el.max);
  el.style.setProperty("--fill", `${((Number(el.value) - min) / (max - min)) * 100}%`);
}

function syncBrushPreview(): void {
  const d = $("#brush-dot");
  const max = 52;
  const size = Math.max(3, Math.min(max, state.brushSize));
  d.style.width = `${size}px`;
  d.style.height = `${size}px`;
  $("#brush-interaction.preview-label").textContent = `⌀ ${state.brushSize} px`;
  $("#ctl-size-val").textContent = `${state.brushSize} px`;
}

function updateColorUI(): void {
  const fg = $("#swatch-fg") as HTMLButtonElement;
  const bg = $("#swatch-bg") as HTMLButtonElement;
  fg.style.background = state.fg;
  bg.style.background = state.bg;
  ($("#color-input") as HTMLInputElement).value = state.fg;
}

function swapColors(): void {
  [state.fg, state.bg] = [state.bg, state.fg];
  updateColorUI();
  toast(`描画色: ${state.fg.toUpperCase()}`, "info");
}

function bindControls(): void {
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
    state.brushSize = Number((e.target as HTMLInputElement).value);
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
      state.brushSize = Number((chip as HTMLElement).dataset.size);
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

/* ============ UI配線: タブ / フィルター / レイヤー ============ */
function bindTabs(): void {
  $$(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      const name = (tab as HTMLElement).dataset.tab;
      $$(".tab").forEach((t) => t.classList.toggle("is-active", t === tab));
      $$(".panel").forEach((p) => p.classList.toggle("is-active", p.id === `panel-${name}`));
    }),
  );
}

const FX_FORMAT: Record<string, (v: number) => string> = {
  blur: (v) => `${v.toFixed(1)} px`,
  noise: (v) => `${Math.round(v)} %`,
  brightness: (v) => `${Math.round(v)} %`,
  contrast: (v) => `${Math.round(v)} %`,
  saturate: (v) => `${Math.round(v)} %`,
  hue: (v) => `${Math.round(v)}°`,
};

function syncFilterUI(): void {
  // フィルターエンジンの数値フィールドへキー文字列でアクセスするためのビュー
  const numeric = filters as unknown as Record<string, number>;
  for (const key of Object.keys(filters.on)) {
    const box = $(`input[data-fx-on="${key}"]`) as HTMLInputElement;
    const range = $(`input[data-fx-range="${key}"]`) as HTMLInputElement;
    const val = $(`[data-fx-val="${key}"]`);
    box.checked = filters.on[key];
    range.value = String(numeric[key]);
    paintRangeFill(range);
    val.textContent = FX_FORMAT[key](numeric[key]);
    ($(`.fx[data-fx="${key}"]`) as HTMLElement).classList.toggle("is-on", filters.on[key]);
  }
  // ノイズの種類 (カラー / グレー) ボタンの反映
  $$("button[data-fx-noise-mode]").forEach((b) =>
    b.classList.toggle("is-active", (b as HTMLElement).dataset.fxNoiseMode === filters.noiseMode),
  );
}

function bindFilters(): void {
  $$("input[data-fx-on]").forEach((el) =>
    el.addEventListener("change", () => {
      const key = (el as HTMLElement).dataset.fxOn!;
      filters.on[key] = (el as HTMLInputElement).checked;
      syncFilterUI();
      markDirty();
      render();
    }),
  );
  $$("input[data-fx-range]").forEach((el) =>
    el.addEventListener("input", () => {
      const key = (el as HTMLElement).dataset.fxRange!;
      (filters as unknown as Record<string, number>)[key] = Number((el as HTMLInputElement).value);
      syncFilterUI();
      if (filters.on[key]) { markDirty(); render(); }
    }),
  );
  // ノイズの種類 (カラー / グレー)
  $$("button[data-fx-noise-mode]").forEach((btn) =>
    btn.addEventListener("click", () => {
      filters.noiseMode = (btn as HTMLElement).dataset.fxNoiseMode as "color" | "gray";
      syncFilterUI();
      if (filters.on.noise) {
        markDirty();
        render();
      }
    }),
  );
  // フィルターの確定(ベイク) / リセット
  $("#btn-filter-apply").addEventListener("click", () => filters.bake());
  $("#btn-filter-reset").addEventListener("click", () => {
    filters.resetValues();
    syncFilterUI();
    render();
    toast("フィルターをリセット", "fx");
  });
}

/* ---------- レイヤー ---------- */
function layerBadgeHTML(l: Layer): string {
  let html = "";
  // 編集対象バッジ (アクティブレイヤー以外の追加対象に表示)
  if (doc.editTargetIds.has(l.id) && l.id !== doc.activeLayerId) {
    html += `<span class="layer__badge layer__badge--target" title="編集対象 (Ctrl+クリックで解除)"><i data-icon="link"></i>編集</span>`;
  }
  if (l.kind === "base") {
    const fxOn = Object.values(filters.on).some(Boolean);
    html += `<span class="layer__badge layer__badge--lock"><i data-icon="lock"></i></span>${fxOn ? '<span class="layer__badge layer__badge--fx">FX</span>' : ""}`;
  }
  return html;
}

function renderLayers(): void {
  const list = $("#layer-list");
  list.innerHTML = "";
  [...doc.layers].reverse().forEach((l) => {
    const li = document.createElement("li");
    li.className = `layer${l.id === doc.activeLayerId ? " is-active" : ""}${doc.editTargetIds.has(l.id) ? " is-target" : ""}${l.visible ? "" : " is-hidden-layer"}`;
    li.innerHTML = `
      <div class="layer__thumb"></div>
      <div class="layer__meta">
        <div class="layer__name">${l.name} ${layerBadgeHTML(l)}</div>
        <div class="layer__sub">${l.kind === "base" ? "元画像 · 前処理フィルター適用" : "640 × 640 · normal"}</div>
      </div>
      <button class="layer__eye" title="表示 / 非表示"><i data-icon="${l.visible ? "eye" : "eye-off"}"></i></button>`;
    (li.querySelector(".layer__thumb") as HTMLElement).appendChild(cloneThumb(l.canvas));
    li.addEventListener("click", (e) => doc.selectLayer(l, e.ctrlKey || e.metaKey || e.shiftKey));
    (li.querySelector(".layer__eye") as HTMLElement).addEventListener("click", (e) => {
      e.stopPropagation();
      l.visible = !l.visible;
      renderLayers();
      render();
    });
    list.appendChild(li);
  });
  mountIcons(list);
  $("#layer-count").textContent = String(doc.layers.length);
  $("#layer-target-count").textContent = String(doc.editTargets().length);
}

function cloneThumb(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 68;
  c.height = 68;
  const g = c.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, 68, 68);
  return c;
}

function bindLayers(): void {
  $("#btn-layer-add").addEventListener("click", () => doc.addLayer());
  $("#btn-layer-dup").addEventListener("click", () => {
    const l = doc.activeLayer();
    if (l.kind === "paint") doc.addLayer(l);
    else toast("背景レイヤーは複製できません", "info");
  });
  $("#btn-layer-del").addEventListener("click", () => doc.deleteActiveLayer());
}

/* ============ Export Modal ============ */
let exportCompositeUrl = "";
let exportMaskUrl = "";

function buildMaskUrl(): string {
  const c = document.createElement("canvas");
  c.width = DOC_W;
  c.height = DOC_H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000000";
  g.fillRect(0, 0, DOC_W, DOC_H);

  // ペイントレイヤーを白で加算
  const tmp = document.createElement("canvas");
  tmp.width = DOC_W;
  tmp.height = DOC_H;
  const tg = tmp.getContext("2d")!;
  for (const l of doc.layers) {
    if (l.kind !== "paint" || !l.visible) continue;
    tg.globalCompositeOperation = "source-over";
    tg.clearRect(0, 0, DOC_W, DOC_H);
    tg.drawImage(l.canvas, 0, 0);
    tg.globalCompositeOperation = "source-in";
    tg.fillStyle = "#ffffff";
    tg.fillRect(0, 0, DOC_W, DOC_H);
    g.drawImage(tmp, 0, 0);
  }
  // 最終選択範囲を白で加算
  if (selection.hasSelection) g.drawImage(selection.mask, 0, 0);
  return c.toDataURL("image/png");
}

function openExport(): void {
  cancelPolygon();
  exportCompositeUrl = doc.compositeCanvas().toDataURL("image/png");
  exportMaskUrl = buildMaskUrl();
  $("#exp-composite").setAttribute("src", exportCompositeUrl);
  $("#exp-mask").setAttribute("src", exportMaskUrl);
  const info = $("#export-info");
  info.classList.remove("is-sent", "is-error");
  info.textContent = `$ JSPAINT_EXPORT · ${DOC_W}×${DOC_H} · mask = 描画要素 + 最終選択範囲 → 待機中…`;
  ($("#modal-export") as HTMLElement).hidden = false;
}

function closeExport(): void {
  ($("#modal-export") as HTMLElement).hidden = true;
}

function downloadDataUrl(name: string, url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

function postToParent(): void {
  const payload = { type: "JSPAINT_EXPORT", compositeImage: exportCompositeUrl, maskImage: exportMaskUrl };
  const info = $("#export-info");
  if (window.parent !== window) {
    window.parent.postMessage(payload, "*");
    info.textContent = '→ window.parent.postMessage({ type: "JSPAINT_EXPORT", compositeImage, maskImage }) 送信済み ✓';
    info.classList.add("is-sent");
    toast("親アプリへ送信しました", "ok");
  } else {
    info.textContent = "⚠ 単体モード (iframe未検出) — 各PNG保存ボタンでダウンロードしてください";
    info.classList.add("is-error");
    toast("単体モードのため PNG 保存で代替します", "info");
  }
}

function bindHeaderAndModal(): void {
  $("#btn-undo").addEventListener("click", () => history.undo());
  $("#btn-redo").addEventListener("click", () => history.redo());
  $("#btn-zoomin").addEventListener("click", () => setZoom(state.zoom * 1.25));
  $("#btn-zoomout").addEventListener("click", () => setZoom(state.zoom / 1.25));
  $("#btn-zoom-label").addEventListener("click", () => setZoom(1));
  $("#btn-fit").addEventListener("click", fitView);
  $("#btn-export").addEventListener("click", openExport);

  $("#btn-cancel").addEventListener("click", () => {
    doc.layers.filter((l) => l.kind === "paint").forEach((l) => l.ctx.clearRect(0, 0, DOC_W, DOC_H));
    selection.clearSelection();
    filters.resetValues();
    syncFilterUI();
    history.clear();
    renderLayers();
    render();
    toast("編集をリセットしました", "info");
  });

  $("#modal-close").addEventListener("click", closeExport);
  $("#modal-cancel").addEventListener("click", closeExport);
  $("#modal-backdrop").addEventListener("click", closeExport);
  $("#btn-postmessage").addEventListener("click", postToParent);
  $$("[data-dl]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const which = (btn as HTMLElement).dataset.dl;
      downloadDataUrl(
        which === "mask" ? "mask.png" : "composite.png",
        which === "mask" ? exportMaskUrl : exportCompositeUrl,
      );
    }),
  );
}

/* ============ キーボードショートカット ============ */
function syncSlider(): void {
  const el = $("#ctl-size") as HTMLInputElement;
  el.value = String(state.brushSize);
  paintRangeFill(el);
  $$(".chip[data-size]").forEach((c) =>
    c.classList.toggle("is-active", Number((c as HTMLElement).dataset.size) === state.brushSize),
  );
  syncBrushPreview();
  render();
}

/* ============ エントリポイント ============ */
export function startApp(): void {
  mountIcons();

  // core からの UI 更新は hooks 経由で行う (実装をここで差し込む)
  setHooks({ render, toast, markDirty, syncToolGuide, renderLayers, updateUndoButtons, syncFilterUI, syncZoomUI });
  // 背景レイヤーの描画 (前処理フィルター) を FilterEngine へ委譲
  doc.setBasePainter((g) => filters.drawBaseLayer(g));
  doc.init(createDemoImage());

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
  bindKeyboard({ openExport, closeExport, setTool, syncSlider, swapColors });

  bindControls();
  bindTabs();
  bindFilters();
  bindLayers();
  bindHeaderAndModal();
}
