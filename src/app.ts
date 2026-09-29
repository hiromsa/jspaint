/**
 * app.ts — JSPaint UI モック本体
 * Photoshop/Figma ライクな Inpainting 前処理ペイントの動作デモ。
 */
import { mountIcons } from "./icons";
import { createDemoImage, DOC_H, DOC_W } from "./demo";

/* ============ 型 ============ */
export type ToolId =
  | "brush" | "eraser" | "bucket"
  | "smudge" | "bloat" | "dodge" | "burn" | "filter-pen"
  | "line" | "rect" | "ellipse"
  | "select-rect" | "lasso" | "polygon" | "wand" | "mask-pen"
  | "eyedropper" | "pan";

type SelMode = "new" | "add" | "sub";

interface Layer {
  id: number;
  name: string;
  kind: "base" | "paint";
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  visible: boolean;
}

const TOOLS: Record<ToolId, { label: string; key: string; guide: string; cursor: string }> = {
  brush:       { label: "ブラシ",       key: "B", guide: "ドラッグで描画 · [ ] でサイズ", cursor: "none" },
  eraser:      { label: "消しゴム",     key: "E", guide: "ドラッグで描画を消去", cursor: "none" },
  bucket:      { label: "塗りつぶし",   key: "G", guide: "クリックで類似色領域を塗りつぶし", cursor: "crosshair" },
  smudge:      { label: "指先",         key: "S", guide: "ドラッグで色をにじませる · [ ] でサイズ", cursor: "none" },
  bloat:       { label: "膨張",         key: "V", guide: "ドラッグで領域を球面状に変形 · 長押しで持続 · [ ] でサイズ · Alt で方向を一時反転", cursor: "none" },
  dodge:       { label: "覆い焼き",     key: "D", guide: "ドラッグで明るく · Alt で焼き込みに反転", cursor: "none" },
  burn:        { label: "焼き込み",     key: "J", guide: "ドラッグで暗く · Alt で覆い焼きに反転", cursor: "none" },
  "filter-pen": { label: "フィルターペン", key: "F", guide: "ドラッグでなぞった範囲にフィルター設定を焼き込む · フィルタータブで内容を設定", cursor: "none" },
  line:        { label: "直線",         key: "L", guide: "ドラッグで直線 · Shift で水平 / 垂直 / 45°", cursor: "crosshair" },
  rect:        { label: "矩形",         key: "U", guide: "ドラッグで矩形 · Shift で正方形", cursor: "crosshair" },
  ellipse:     { label: "円",           key: "O", guide: "ドラッグで楕円 · Shift で正円", cursor: "crosshair" },
  "select-rect": { label: "矩形選択",   key: "M", guide: "ドラッグで範囲選択 (サイズ表示あり) · Shift=追加 / Alt=除外", cursor: "crosshair" },
  lasso:       { label: "投げ縄選択",   key: "Q", guide: "ドラッグで囲んで選択", cursor: "crosshair" },
  polygon:     { label: "多角形選択",   key: "P", guide: "クリックで頂点追加 / ドラッグでフリーハンド · ダブルクリック / Enter で確定 · Esc で取消", cursor: "crosshair" },
  wand:        { label: "魔法の杖",     key: "W", guide: "クリックで類似色範囲を選択", cursor: "crosshair" },
  "mask-pen":  { label: "選択ペン",     key: "K", guide: "ドラッグで選択マスクを描く · Shift=追加 / Alt=除外", cursor: "none" },
  eyedropper:  { label: "スポイト",     key: "I", guide: "クリックで描画色を取得", cursor: "crosshair" },
  pan:         { label: "手のひら",     key: "H", guide: "ドラッグで表示移動 · ホイールでズーム", cursor: "grab" },
};

/* ============ DOM ============ */
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement>(sel: string) => Array.from(document.querySelectorAll(sel)) as T[];

const view = $("#view") as HTMLCanvasElement;
const vctx = view.getContext("2d")!;
const stage = $("#stage");
const workspace = $("#workspace");

/* ============ 状態 ============ */
const state = {
  tool: "brush" as ToolId,
  fg: "#2563eb",
  bg: "#ffffff",
  brushSize: 24,
  opacity: 100,
  fillShape: true,
  tolerance: 25,
  selMode: "new" as SelMode,
  /** 膨張ブラシの効果方向: 1 = 膨張 / -1 = 収縮 (Alt で一時反転) */
  bloatDir: 1 as 1 | -1,
  zoom: 1,
  panX: 0,
  panY: 0,
  dirty: false,
  spacePan: false,
};

let layers: Layer[] = [];
let nextLayerId = 1;
let activeLayerId = 2;
/** 編集対象レイヤー (描画 / レタッチ系ツールが作用する対象)。常に activeLayerId を含む */
let editTargetIds = new Set<number>();

/* ============ 選択 (Marching Ants) ============ */
const selMask = document.createElement("canvas");
selMask.width = DOC_W;
selMask.height = DOC_H;
const selCtx = selMask.getContext("2d")!;
let hasSelection = false;
let antsBlack!: HTMLCanvasElement;
const antsWhite: HTMLCanvasElement[] = [];
let antPhase = 0;

const activeLayer = () => layers.find((l) => l.id === activeLayerId)!;

/** 編集対象レイヤー一覧 (activeLayer を必ず含む。layers の並び順) */
function editTargets(): Layer[] {
  const ids = new Set(editTargetIds);
  ids.add(activeLayerId);
  return layers.filter((l) => ids.has(l.id));
}

function makeLayer(name: string, kind: "base" | "paint", image?: HTMLCanvasElement): Layer {
  const canvas = document.createElement("canvas");
  canvas.width = DOC_W;
  canvas.height = DOC_H;
  // レタッチ系ツール (覆い焼き/焼き込み) は getImageData を頻用するため CPU 側バッファを優先
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  if (image) ctx.drawImage(image, 0, 0);
  return { id: nextLayerId++, name, kind, canvas, ctx, visible: true };
}

/* ============ Undo / Redo ============ */
/** 1レイヤー分のスナップショット (複数レイヤー編集対象に対応) */
interface LayerSnap {
  layerId: number;
  layer: HTMLCanvasElement;
}
interface Snap {
  layers: LayerSnap[];
  sel: HTMLCanvasElement;
  hasSel: boolean;
}
const undoStack: Snap[] = [];
const redoStack: Snap[] = [];

function clone(c: HTMLCanvasElement): HTMLCanvasElement {
  const n = document.createElement("canvas");
  n.width = c.width;
  n.height = c.height;
  n.getContext("2d")!.drawImage(c, 0, 0);
  return n;
}

/** Undo 対象レイヤーのスナップショットを積む。未指定時は現在の編集対象レイヤーすべて */
function pushUndo(target?: Layer | Layer[]): void {
  const list = target ? (Array.isArray(target) ? target : [target]) : editTargets();
  undoStack.push({
    layers: list.map((l) => ({ layerId: l.id, layer: clone(l.canvas) })),
    sel: clone(selMask),
    hasSel: hasSelection,
  });
  if (undoStack.length > 40) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}

/** 反対スタックへ積む「現在状態」のスナップショット (pop したスナップショットと同じレイヤー集合) */
function snapCurrent(layerIds: number[]): LayerSnap[] {
  return layerIds
    .map((id) => layers.find((l) => l.id === id))
    .filter((l): l is Layer => Boolean(l))
    .map((l) => ({ layerId: l.id, layer: clone(l.canvas) }));
}

/** スナップショットをレイヤー / 選択状態へ復元 */
function restoreSnap(s: Snap): void {
  for (const { layerId, layer } of s.layers) {
    const t = layers.find((x) => x.id === layerId);
    if (t) {
      t.ctx.clearRect(0, 0, DOC_W, DOC_H);
      t.ctx.drawImage(layer, 0, 0);
    }
  }
  selCtx.clearRect(0, 0, DOC_W, DOC_H);
  if (s.hasSel) selCtx.drawImage(s.sel, 0, 0);
  hasSelection = s.hasSel;
  rebuildAnts();
  syncToolGuide();
  renderLayers();
  updateUndoButtons();
}

function undo(): void {
  const s = undoStack.pop();
  if (!s) return;
  redoStack.push({ layers: snapCurrent(s.layers.map((x) => x.layerId)), sel: clone(selMask), hasSel: hasSelection });
  restoreSnap(s);
}

function redo(): void {
  const s = redoStack.pop();
  if (!s) return;
  undoStack.push({ layers: snapCurrent(s.layers.map((x) => x.layerId)), sel: clone(selMask), hasSel: hasSelection });
  restoreSnap(s);
}

function updateUndoButtons(): void {
  ($("#btn-undo") as HTMLButtonElement).disabled = undoStack.length === 0;
  ($("#btn-redo") as HTMLButtonElement).disabled = redoStack.length === 0;
}

/* ============ Toast / ドキュメント状態 ============ */
function toast(msg: string, kind: "info" | "ok" | "fx" = "info"): void {
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.classList.add("is-out"), 2200);
  setTimeout(() => el.remove(), 2500);
}

function markDirty(): void {
  if (state.dirty) return;
  state.dirty = true;
  $("#doc-dot").classList.add("doc-dot--editing");
  const st = $("#doc-status");
  st.textContent = "EDITING";
  st.classList.remove("doc-status--ready");
  st.classList.add("doc-status--editing");
}

/* ============ 前処理フィルター (背景レイヤーに適用) ============ */
const filters = {
  blur: 0,
  noise: 0,
  /** ノイズの種類: "color" = RGB独立ランダム / "gray" = 明るさのみのグレイン */
  noiseMode: "color" as "color" | "gray",
  brightness: 100,
  contrast: 100,
  saturate: 100,
  hue: 0,
  on: { blur: false, noise: false, brightness: false, contrast: false, saturate: false, hue: false } as Record<string, boolean>,
};

function filterString(): string {
  const parts: string[] = [];
  if (filters.on.blur && filters.blur > 0) parts.push(`blur(${filters.blur}px)`);
  if (filters.on.brightness) parts.push(`brightness(${filters.brightness}%)`);
  if (filters.on.contrast) parts.push(`contrast(${filters.contrast}%)`);
  if (filters.on.saturate) parts.push(`saturate(${filters.saturate}%)`);
  if (filters.on.hue) parts.push(`hue-rotate(${filters.hue}deg)`);
  return parts.length ? parts.join(" ") : "none";
}

function filtersActive(): boolean {
  return Object.values(filters.on).some(Boolean);
}

/** フィルター適用作業用の一時canvas */
const fxTmp = document.createElement("canvas");
fxTmp.width = DOC_W;
fxTmp.height = DOC_H;

/**
 * 背景レイヤー(元画像)を描画する。
 * フィルター有効時、選択範囲があれば「その範囲のみ」にフィルターを適用する。
 */
function drawBaseLayer(g: CanvasRenderingContext2D): void {
  const base = layers.find((l) => l.kind === "base");
  if (!base?.visible) return;
  if (!filtersActive()) {
    g.drawImage(base.canvas, 0, 0);
    return;
  }
  // 1) フィルター適用版を全面に描く
  g.filter = filterString();
  g.drawImage(base.canvas, 0, 0);
  if (filters.on.noise && filters.noise > 0) drawNoise(g);
  g.filter = "none";
  // 2) 選択範囲の外側を「フィルターなし」で上書き
  if (hasSelection) {
    const tg = fxTmp.getContext("2d")!;
    tg.globalCompositeOperation = "source-over";
    tg.clearRect(0, 0, DOC_W, DOC_H);
    tg.drawImage(base.canvas, 0, 0);
    tg.globalCompositeOperation = "destination-out";
    tg.drawImage(selMask, 0, 0);
    tg.globalCompositeOperation = "source-over";
    g.drawImage(fxTmp, 0, 0);
  }
}

/* ============ 座標変換 / ズーム ============ */
let vw = 0;
let vh = 0;
const dpr = Math.min(window.devicePixelRatio || 1, 2);

/**
 * 画面(CSS px)⇔ドキュメント座標の相互変換。
 * render() と同じ「ドキュメント中心基準」の写像を使うこと(ズレ防止)。
 *   screen = vw/2 + pan + (doc − DOC中心) × zoom
 */
function screenToDoc(sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - vw / 2 - state.panX) / state.zoom + DOC_W / 2,
    y: (sy - vh / 2 - state.panY) / state.zoom + DOC_H / 2,
  };
}
function docToScreenX(dx: number): number {
  return vw / 2 + state.panX + (dx - DOC_W / 2) * state.zoom;
}
function docToScreenY(dy: number): number {
  return vh / 2 + state.panY + (dy - DOC_H / 2) * state.zoom;
}

function setZoom(z: number, cx?: number, cy?: number): void {
  const nz = Math.min(8, Math.max(0.05, z));
  const px = cx ?? vw / 2;
  const py = cy ?? vh / 2;
  const dx = (px - vw / 2 - state.panX) / state.zoom;
  const dy = (py - vh / 2 - state.panY) / state.zoom;
  state.zoom = nz;
  state.panX = px - vw / 2 - dx * nz;
  state.panY = py - vh / 2 - dy * nz;
  syncZoomUI();
  render();
}

function fitView(): void {
  state.zoom = Math.min((vw - 56) / DOC_W, (vh - 56) / DOC_H);
  state.panX = 0;
  state.panY = 0;
  syncZoomUI();
  render();
}

function syncZoomUI(): void {
  const pct = `${Math.round(state.zoom * 100)}%`;
  $("#btn-zoom-label").textContent = pct;
  $("#ws-zoom").textContent = pct;
  $("#st-zoom").textContent = pct;
}

/* ============ Marching Ants (境界エッジの二値描画を4相で巡回) ============ */
function rebuildAnts(): void {
  antsBlack = document.createElement("canvas");
  antsBlack.width = DOC_W;
  antsBlack.height = DOC_H;
  for (let i = 0; i < 4; i++) {
    const c = document.createElement("canvas");
    c.width = DOC_W;
    c.height = DOC_H;
    antsWhite[i] = c;
  }
  if (!hasSelection) return;

  const img = selCtx.getImageData(0, 0, DOC_W, DOC_H);
  const d = img.data;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= DOC_W || y >= DOC_H ? 0 : d[(y * DOC_W + x) * 4 + 3]);

  const bCtx = antsBlack.getContext("2d")!;
  bCtx.fillStyle = "#000";
  const wCtx = antsWhite.map((c) => c.getContext("2d")!);
  wCtx.forEach((c) => (c.fillStyle = "#fff"));

  for (let y = 0; y < DOC_H; y++) {
    for (let x = 0; x < DOC_W; x++) {
      if (at(x, y) < 128) continue;
      const edge = at(x - 1, y) < 128 || at(x + 1, y) < 128 || at(x, y - 1) < 128 || at(x, y + 1) < 128;
      if (!edge) continue;
      bCtx.fillRect(x, y, 1, 1);
      const p = (x + y) & 3;
      wCtx[p].fillRect(x, y, 1, 1);
      wCtx[(p + 1) & 3].fillRect(x, y, 1, 1);
    }
  }
}

/* ============ レンダリング ============ */
let preview: { tool: ToolId; x0: number; y0: number; x1: number; y1: number } | null = null;
let lassoPath: { x: number; y: number }[] | null = null;
let polyPoints: { x: number; y: number }[] = [];
let polyHover: { x: number; y: number } | null = null;
let polyDrag: { pts: { x: number; y: number }[]; moved: boolean } | null = null;
let maskStroke: { mode: SelMode; last: { x: number; y: number } } | null = null;
let cursorPos: { x: number; y: number } | null = null;

function resizeView(): void {
  vw = workspace.clientWidth;
  vh = workspace.clientHeight;
  view.width = Math.max(1, Math.round(vw * dpr));
  view.height = Math.max(1, Math.round(vh * dpr));
  view.style.width = `${vw}px`;
  view.style.height = `${vh}px`;
  render();
}

function render(): void {
  if (!vw) return;
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  vctx.clearRect(0, 0, vw, vh);

  vctx.save();
  vctx.translate(vw / 2 + state.panX, vh / 2 + state.panY);
  vctx.scale(state.zoom, state.zoom);
  vctx.translate(-DOC_W / 2, -DOC_H / 2);

  // チェッカーボード (透明部分の表現)
  const chk = 8;
  vctx.fillStyle = "#1e1e1e";
  vctx.fillRect(0, 0, DOC_W, DOC_H);
  vctx.fillStyle = "#2a2a2a";
  for (let y = 0; y < DOC_H / chk; y++) {
    for (let x = 0; x < DOC_W / chk; x++) {
      if ((x + y) % 2 === 0) vctx.fillRect(x * chk, y * chk, chk, chk);
    }
  }

  // 背景レイヤー (前処理フィルター — 選択範囲がある場合はその範囲のみ適用)
  drawBaseLayer(vctx);

  // ペイントレイヤー (下 → 上)
  for (const l of layers) {
    if (l.kind === "paint" && l.visible) vctx.drawImage(l.canvas, 0, 0);
  }

  drawStrokePreview(vctx);
  drawSelectionPreview(vctx);

  vctx.restore();

  // ドラッグ中のサイズ表示 (矩形選択 / 図形)
  drawDragSizeBadge(vctx);

  // Marching ants (doc解像度のエッジ層を重ね描き)
  if (hasSelection && antsBlack) {
    vctx.save();
    vctx.translate(vw / 2 + state.panX, vh / 2 + state.panY);
    vctx.scale(state.zoom, state.zoom);
    vctx.translate(-DOC_W / 2, -DOC_H / 2);
    vctx.imageSmoothingEnabled = false;
    vctx.drawImage(antsBlack, 0, 0);
    vctx.drawImage(antsWhite[antPhase % 4], 0, 0);
    vctx.restore();
  }

  drawCursor();
}

/** ノイズ(グレイン) — シード固定の決定論的パターンをキャッシュして再利用 (カラー / グレー) */
const noiseCaches: Record<"color" | "gray", HTMLCanvasElement | null> = { color: null, gray: null };
function getNoiseCanvas(mode: "color" | "gray"): HTMLCanvasElement {
  const cached = noiseCaches[mode];
  if (cached) return cached;
  const n = document.createElement("canvas");
  n.width = DOC_W;
  n.height = DOC_H;
  const nc = n.getContext("2d")!;
  const img = nc.createImageData(DOC_W, DOC_H);
  let s = 0x9e3779b9; // xorshift32 固定シード
  const rand = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  for (let i = 0; i < img.data.length; i += 4) {
    if (mode === "gray") {
      // グレースケールノイズ: 明るさのみのランダム値 (フィルムグレイン)
      const v = rand() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    } else {
      // カラーノイズ: RGB に独立したランダム値 (カラーグレイン)
      img.data[i] = rand() * 255;
      img.data[i + 1] = rand() * 255;
      img.data[i + 2] = rand() * 255;
    }
    img.data[i + 3] = 255;
  }
  nc.putImageData(img, 0, 0);
  noiseCaches[mode] = n;
  return n;
}

function drawNoise(g: CanvasRenderingContext2D): void {
  const strength = filters.noise / 100;
  if (strength <= 0) return;
  g.save();
  g.globalAlpha = strength;
  g.drawImage(getNoiseCanvas(filters.noiseMode), 0, 0);
  g.restore();
}

function drawStrokePreview(g: CanvasRenderingContext2D): void {
  if (!preview) return;
  const { x0, y0, x1, y1, tool } = preview;
  g.save();
  g.strokeStyle = "#fff";
  g.fillStyle = hexA(state.fg, 0.45);
  g.lineWidth = 1 / state.zoom;
  g.setLineDash([4 / state.zoom, 3 / state.zoom]);
  const w = x1 - x0;
  const h = y1 - y0;
  if (tool === "line") {
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  } else if (tool === "rect") {
    g.fillRect(x0, y0, w, h);
    g.strokeRect(x0, y0, w, h);
  } else if (tool === "ellipse") {
    g.beginPath();
    g.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
  g.restore();
}

function drawSelectionPreview(g: CanvasRenderingContext2D): void {
  g.save();
  g.lineWidth = 1 / state.zoom;

  // 矩形選択: ドラッグ中の範囲を色付きオーバーレイ + 破線枠で表示
  if (preview && preview.tool === "select-rect") {
    const { x0, y0, x1, y1 } = preview;
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    // モード色 (確定時の適用モードと対応): 新規=青 / 追加(Shift)=緑 / 除外(Alt)=赤
    const mode = dragMods ?? state.selMode;
    const tint = mode === "add" ? "34, 197, 94" : mode === "sub" ? "239, 68, 68" : "96, 165, 250";
    g.fillStyle = `rgba(${tint}, 0.28)`;
    g.fillRect(x, y, w, h);
    // 枠: どの背景でも見えるよう黒の下地線 + 白破線 (既存選択がある間は ants に合わせて破線が流れる)
    g.strokeStyle = "rgba(0, 0, 0, 0.8)";
    g.strokeRect(x, y, w, h);
    g.strokeStyle = "#fff";
    g.setLineDash([4 / state.zoom, 3 / state.zoom]);
    g.lineDashOffset = (-antPhase * 2) / state.zoom;
    g.strokeRect(x, y, w, h);
  }

  if (lassoPath && lassoPath.length > 1) {
    g.strokeStyle = "#fff";
    g.setLineDash([4 / state.zoom, 3 / state.zoom]);
    g.beginPath();
    g.moveTo(lassoPath[0].x, lassoPath[0].y);
    for (const p of lassoPath) g.lineTo(p.x, p.y);
    g.stroke();
  }
  if (state.tool === "polygon" && (polyPoints.length > 0 || polyDrag)) {
    const pts = polyDrag ? polyPoints.concat(polyDrag.pts) : polyPoints;
    g.strokeStyle = "#fff";
    g.setLineDash([4 / state.zoom, 3 / state.zoom]);
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (const p of pts) g.lineTo(p.x, p.y);
    if (polyHover) g.lineTo(polyHover.x, polyHover.y);
    g.stroke();

    // 頂点ハンドル (確定済み頂点のみ。始点は緑ドット)
    polyPoints.forEach((p, i) => {
      g.beginPath();
      g.arc(p.x, p.y, (i === 0 ? 6 : 3.5) / state.zoom, 0, Math.PI * 2);
      g.setLineDash([]);
      if (i === 0) {
        g.fillStyle = "#22c55e";
        g.fill();
        g.strokeStyle = "#fff";
      } else {
        g.fillStyle = "#fff";
        g.fill();
        g.strokeStyle = "#000";
      }
      g.stroke();
    });
  }
  g.restore();
}

/** ドラッグ中の図形 / 矩形選択サイズバッジ (W×H、直線は長さ) */
function drawDragSizeBadge(g: CanvasRenderingContext2D): void {
  if (!preview) return;
  const { tool, x0, y0, x1, y1 } = preview;
  let label: string;
  if (tool === "line") {
    label = `Len: ${Math.round(Math.hypot(x1 - x0, y1 - y0))} px`;
  } else {
    label = `W: ${Math.round(Math.abs(x1 - x0))}  H: ${Math.round(Math.abs(y1 - y0))}`;
  }
  // 矩形選択: モード修飾中 (Shift=追加 / Alt=除外) は先頭に記号を添える
  if (tool === "select-rect" && dragMods) {
    label = `${dragMods === "add" ? "＋" : "−"} ${label}`;
  }
  const padX = 7;
  const padY = 4;
  g.save();
  g.font = "600 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const bw = g.measureText(label).width + padX * 2;
  const bh = 11 + padY * 2;
  // ドラッグ矩形の右下 (スクリーン座標) に配置し、ビューポート内にクランプ
  let bx = docToScreenX(Math.max(x0, x1)) + 10;
  let by = docToScreenY(Math.max(y0, y1)) + 12;
  bx = Math.min(Math.max(4, bx), vw - bw - 4);
  by = Math.min(Math.max(4, by), vh - bh - 4);
  g.fillStyle = "rgba(10, 12, 18, 0.85)";
  g.strokeStyle = "rgba(255, 255, 255, 0.22)";
  g.lineWidth = 1;
  g.beginPath();
  roundRectPath(g, bx, by, bw, bh, 5);
  g.fill();
  g.stroke();
  g.fillStyle = "#fff";
  g.textBaseline = "middle";
  g.fillText(label, bx + padX, by + bh / 2 + 0.5);
  g.restore();
}

/** 角丸矩形のパスを構築 (canvas 標準 roundRect を使わない代替) */
function roundRectPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

function drawCursor(): void {
  if (!cursorPos) return;
  const circleCursor: ToolId[] = ["brush", "eraser", "mask-pen", "smudge", "bloat", "dodge", "burn", "filter-pen"];
  if (!circleCursor.includes(state.tool)) return;
  const r = Math.max(2, (state.brushSize * state.zoom) / 2);
  const x = docToScreenX(cursorPos.x);
  const y = docToScreenY(cursorPos.y);
  vctx.save();
  vctx.lineWidth = 1;
  vctx.strokeStyle = "rgba(0,0,0,0.75)";
  vctx.beginPath();
  vctx.arc(x, y, r + 1, 0, Math.PI * 2);
  vctx.stroke();
  vctx.strokeStyle = "rgba(255,255,255,0.9)";
  vctx.beginPath();
  vctx.arc(x, y, r, 0, Math.PI * 2);
  vctx.stroke();
  vctx.fillStyle = "rgba(255,255,255,0.9)";
  vctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
  vctx.restore();
}

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ants アニメーション (120ms 毎に相を進めて再描画) */
function startAntLoop(): void {
  let last = 0;
  const tick = (t: number): void => {
    if (t - last > 120) {
      last = t;
      if (hasSelection) {
        antPhase = (antPhase + 1) % 4;
        render();
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ============ 合成 / Flood Fill / 選択適用 ============ */
function compositeCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = DOC_W;
  c.height = DOC_H;
  const g = c.getContext("2d")!;
  drawBaseLayer(g);
  for (const l of layers) {
    if (l.kind === "paint" && l.visible) g.drawImage(l.canvas, 0, 0);
  }
  return c;
}

/** スキャンライン flood fill。白二値マスクcanvasを返す */
function floodMask(cx: number, cy: number, tolerance: number): HTMLCanvasElement {
  const img = compositeCanvas().getContext("2d")!.getImageData(0, 0, DOC_W, DOC_H);
  const d = img.data;
  const sx = Math.max(0, Math.min(DOC_W - 1, cx | 0));
  const sy = Math.max(0, Math.min(DOC_H - 1, cy | 0));
  const si = sy * DOC_W + sx;
  const r0 = d[si * 4], g0 = d[si * 4 + 1], b0 = d[si * 4 + 2];
  const thresh = (tolerance / 100) * 383;
  const mask = new Uint8Array(DOC_W * DOC_H);
  const match = (i: number): boolean => {
    const dr = d[i * 4] - r0, dg = d[i * 4 + 1] - g0, db = d[i * 4 + 2] - b0;
    return Math.abs(dr) + Math.abs(dg) + Math.abs(db) <= thresh;
  };

  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    let i = y * DOC_W + x;
    while (x >= 0 && !mask[i] && match(i)) { x--; i--; }
    x++; i++;
    let up = false;
    let down = false;
    while (x < DOC_W && !mask[i] && match(i)) {
      mask[i] = 1;
      if (y > 0) {
        const ui = i - DOC_W;
        const m = !mask[ui] && match(ui);
        if (m && !up) { stack.push(x, y - 1); up = true; } else if (!m) up = false;
      }
      if (y < DOC_H - 1) {
        const di = i + DOC_W;
        const m = !mask[di] && match(di);
        if (m && !down) { stack.push(x, y + 1); down = true; } else if (!m) down = false;
      }
      x++; i++;
    }
  }

  const out = document.createElement("canvas");
  out.width = DOC_W;
  out.height = DOC_H;
  const oc = out.getContext("2d")!;
  const od = oc.createImageData(DOC_W, DOC_H);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      od.data[i * 4] = 255;
      od.data[i * 4 + 1] = 255;
      od.data[i * 4 + 2] = 255;
      od.data[i * 4 + 3] = 255;
    }
  }
  oc.putImageData(od, 0, 0);
  return out;
}

/** マスクcanvasを指定色に着色 */
function tintMask(mask: HTMLCanvasElement, color: string): void {
  const g = mask.getContext("2d")!;
  g.globalCompositeOperation = "source-in";
  g.fillStyle = color;
  g.fillRect(0, 0, DOC_W, DOC_H);
  g.globalCompositeOperation = "source-over";
}

/** 選択形状を selMask へ合成 (新規 / 追加 / 除外 — Shift/Alt 修飾優先) */
function applySelection(shape: (g: CanvasRenderingContext2D) => void, modeOverride?: SelMode): void {
  const mode = modeOverride ?? dragMods ?? state.selMode;
  if (mode === "new") selCtx.clearRect(0, 0, DOC_W, DOC_H);
  selCtx.globalCompositeOperation = mode === "sub" ? "destination-out" : "source-over";
  selCtx.fillStyle = "#fff";
  shape(selCtx);
  selCtx.globalCompositeOperation = "source-over";
  hasSelection = selHasContent();
  rebuildAnts();
  syncToolGuide();
  markDirty();
}

function selHasContent(): boolean {
  const d = selCtx.getImageData(0, 0, DOC_W, DOC_H).data;
  for (let i = 3; i < d.length; i += 16) if (d[i] > 0) return true;
  return false;
}

function clearSelection(): void {
  selCtx.clearRect(0, 0, DOC_W, DOC_H);
  hasSelection = false;
  rebuildAnts();
  syncToolGuide();
}

/** 選択範囲を描画色で塗りつぶし */
function fillSelection(): void {
  if (!hasSelection) {
    toast("先に選択範囲を作成してください", "info");
    return;
  }
  const targets = editTargets().filter((l) => l.kind === "paint");
  if (!targets.length) {
    toast("ペイントレイヤーを編集対象にしてください", "info");
    return;
  }
  pushUndo();
  const m = clone(selMask);
  tintMask(m, state.fg);
  targets.forEach((l) => {
    l.ctx.save();
    l.ctx.globalAlpha = state.opacity / 100;
    l.ctx.drawImage(m, 0, 0);
    l.ctx.restore();
  });
  markDirty();
  render();
  toast(targets.length > 1 ? `選択範囲を ${targets.length} レイヤーに塗りつぶしました` : "選択範囲を塗りつぶしました", "ok");
}

/** 選択解除 (Ctrl+D) */
function deselect(): void {
  if (!hasSelection) return;
  clearSelection();
  toast("選択を解除しました", "info");
}

function selectAll(): void {
  applySelection((g) => g.fillRect(0, 0, DOC_W, DOC_H), "new");
  toast("キャンバス全体を選択", "info");
}

/** 合成画像から色を取得 */
function pickColor(x: number, y: number): string | null {
  if (x < 0 || y < 0 || x >= DOC_W || y >= DOC_H) return null;
  const d = compositeCanvas().getContext("2d")!.getImageData(x | 0, y | 0, 1, 1).data;
  const to2 = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to2(d[0])}${to2(d[1])}${to2(d[2])}`;
}

/* ============ レタッチツール (指先 / 覆い焼き / 焼き込み) ============ */
/** レタッチは編集対象レイヤー (アクティブ + Ctrl+クリックで追加した対象) に直接作用する */

let retouchLast: { x: number; y: number } | null = null;

/* --- 指先 (スマッジ) --- */
const stampBuf = document.createElement("canvas");
const stampCtx = stampBuf.getContext("2d")!;
let stampBufSize = 0;

function ensureStampBuf(size: number): void {
  if (stampBufSize === size) return;
  stampBuf.width = size;
  stampBuf.height = size;
  stampBufSize = size;
}

/** from 周辺の対象レイヤー画像を円形ソフトマスクで切り出し、to へ引きずってスタンプ */
function smudgeStamp(target: Layer, from: { x: number; y: number }, to: { x: number; y: number }): void {
  const size = Math.max(2, Math.round(state.brushSize));
  const r = size / 2;
  ensureStampBuf(size);
  const g = stampCtx;
  g.clearRect(0, 0, size, size);
  // 円形ソフトマスク (中心〜55%は不透明、外周へ滑らかにフェード)
  const grad = g.createRadialGradient(r, r, r * 0.55, r, r, r);
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.beginPath();
  g.arc(r, r, r, 0, Math.PI * 2);
  g.fill();
  // from 周辺の対象レイヤー画像をマスクで切り出す (ソース矩形はドキュメント内にクランプ)
  const sx = from.x - r;
  const sy = from.y - r;
  const cx0 = Math.max(0, Math.floor(sx));
  const cy0 = Math.max(0, Math.floor(sy));
  const cx1 = Math.min(DOC_W, Math.ceil(sx + size));
  const cy1 = Math.min(DOC_H, Math.ceil(sy + size));
  if (cx1 > cx0 && cy1 > cy0) {
    g.globalCompositeOperation = "source-in";
    g.drawImage(target.canvas, cx0, cy0, cx1 - cx0, cy1 - cy0, cx0 - sx, cy0 - sy, cx1 - cx0, cy1 - cy0);
    g.globalCompositeOperation = "source-over";
  }
  if (hasSelection) {
    // 選択範囲がある場合はスタンプを選択マスクで切り抜き、外側に効果が出ないようにする
    g.globalCompositeOperation = "destination-in";
    g.drawImage(selMask, Math.round(to.x - r), Math.round(to.y - r), size, size, 0, 0, size, size);
    g.globalCompositeOperation = "source-over";
  }
  const ctx = target.ctx;
  ctx.save();
  ctx.globalAlpha = Math.min(1, (state.opacity / 100) * 0.85);
  ctx.drawImage(stampBuf, Math.round(to.x - r), Math.round(to.y - r));
  ctx.restore();
}

/* --- 覆い焼き / 焼き込み --- */
/** 円形フォールオフ: t = 0 (中心) → 1 (エッジ)。中心55%は全強度、外周へ cos フェード */
function toneFalloff(t: number): number {
  return t <= 0.55 ? 1 : 0.5 * (1 + Math.cos(((t - 0.55) / 0.45) * Math.PI));
}

/** at を中心に、円形フォールオフで対象レイヤーの輝度を加減算する */
function toneStamp(target: Layer, mode: "dodge" | "burn", at: { x: number; y: number }): void {
  const size = Math.ceil(state.brushSize);
  const r = state.brushSize / 2;
  const x0 = Math.floor(at.x - r);
  const y0 = Math.floor(at.y - r);
  const sx = Math.max(0, x0);
  const sy = Math.max(0, y0);
  const ex = Math.min(DOC_W, x0 + size + 1);
  const ey = Math.min(DOC_H, y0 + size + 1);
  if (ex <= sx || ey <= sy) return;
  const ctx = target.ctx;
  const img = ctx.getImageData(sx, sy, ex - sx, ey - sy);
  const d = img.data;
  const w = ex - sx;
  const h = ey - sy;
  const cx = at.x - sx;
  const cy = at.y - sy;
  const kBase = (state.opacity / 100) * 0.4;
  // 選択範囲がある場合は選択マスクのアルファで効果を減衰 (0 = 完全に効果なし)
  const selD = hasSelection ? selCtx.getImageData(sx, sy, w, h).data : null;
  for (let y = 0; y < h; y++) {
    const dy = y + 0.5 - cy;
    const dy2 = dy * dy;
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx;
      const t = Math.sqrt(dx * dx + dy2) / r;
      if (t >= 1) continue;
      const m = toneFalloff(t);
      if (m <= 0.004) continue;
      const i = (y * w + x) * 4;
      let k = kBase * m;
      if (selD) {
        const sa = selD[i + 3] / 255;
        if (sa <= 0) continue;
        k *= sa;
      }
      if (mode === "dodge") {
        d[i] += (255 - d[i]) * k;
        d[i + 1] += (255 - d[i + 1]) * k;
        d[i + 2] += (255 - d[i + 2]) * k;
      } else {
        d[i] -= d[i] * k;
        d[i + 1] -= d[i + 1] * k;
        d[i + 2] -= d[i + 2] * k;
      }
    }
  }
  ctx.putImageData(img, sx, sy);
}

/** Alt キーで覆い焼き ⇔ 焼き込みを反転 */
function toneMode(alt: boolean): "dodge" | "burn" {
  const t = state.tool === "burn" ? "burn" : "dodge";
  return alt ? (t === "dodge" ? "burn" : "dodge") : t;
}

/* --- 膨張 (ブロート) --- */
/** 1 スタンプで中心付近のサンプル距離を縮める最大率。ドラッグ中はスタンプが繰り返し適用され、徐々に膨らむ */
const BLOAT_PULL = 0.32;

/**
 * at を中心に画像を球面状に膨らませる (リキフィの膨張)。
 * 逆マッピング方式: 出力ピクセルごとに「中心方向へ f だけ寄った位置」をバイリニア補間で
 * サンプルし直す。f は中心で最大・円周で 0 のフォールオフなので、中心ほど強く拡大され、
 * 外周へ滑らかに減衰する。sign = -1 で収縮 (ピンチ) に反転。
 * pull は 1 スタンプの引き寄せ率 (ドラッグのスタンプは既定値、ホールド中の連続適用は
 * 経過時間比例の小さい値)。選択範囲がある場合は選択マスクのアルファで効果を減衰する。
 */
function bloatStamp(target: Layer, at: { x: number; y: number }, sign: 1 | -1, pull: number = BLOAT_PULL): void {
  const size = Math.ceil(state.brushSize);
  const r = state.brushSize / 2;
  const x0 = Math.floor(at.x - r);
  const y0 = Math.floor(at.y - r);
  const sx = Math.max(0, x0);
  const sy = Math.max(0, y0);
  const ex = Math.min(DOC_W, x0 + size + 1);
  const ey = Math.min(DOC_H, y0 + size + 1);
  if (ex <= sx || ey <= sy) return;
  const ctx = target.ctx;
  const w = ex - sx;
  const h = ey - sy;
  // 現在のピクセルをソースとして保持し、結果は別バッファへ書く (円の外側は元のまま)
  const src = ctx.getImageData(sx, sy, w, h);
  const out = ctx.createImageData(w, h);
  out.data.set(src.data);
  const sd = src.data;
  const od = out.data;
  const cx = at.x - sx;
  const cy = at.y - sy;
  const k = (state.opacity / 100) * pull;
  // 選択範囲がある場合は選択マスクのアルファで効果を減衰 (0 = 完全に効果なし)
  const selD = hasSelection ? selCtx.getImageData(sx, sy, w, h).data : null;
  for (let y = 0; y < h; y++) {
    const dy = y + 0.5 - cy;
    const dy2 = dy * dy;
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx;
      const t = Math.sqrt(dx * dx + dy2) / r;
      if (t >= 1) continue;
      let f = toneFalloff(t) * k;
      if (f <= 0.0001) continue;
      if (selD) {
        const sa = selD[(y * w + x) * 4 + 3] / 255;
        if (sa <= 0) continue;
        f *= sa;
      }
      // 逆マッピング: 膨張なら中心側へ、収縮なら外側へサンプル位置をずらす
      const m = 1 - sign * f;
      const mx = cx + dx * m;
      const my = cy + dy * m;
      // バイリニア補間 (透過ピクセルを含むため premultiply してから混ぜる)
      // サンプル座標 mx は「ピクセル中心 = 整数 + 0.5」基準のため、インデックス化する際に
      // -0.5 してから floor する (補正しないと毎スタンプ恒久的に (-0.5, -0.5) px ずれ、
      // 連続適用で画像が左上へ流れてしまう)
      const fx0 = Math.floor(mx - 0.5);
      const fy0 = Math.floor(my - 0.5);
      const rx = mx - 0.5 - fx0;
      const ry = my - 0.5 - fy0;
      const xA = Math.max(0, Math.min(w - 1, fx0));
      const xB = Math.max(0, Math.min(w - 1, fx0 + 1));
      const yA = Math.max(0, Math.min(h - 1, fy0));
      const yB = Math.max(0, Math.min(h - 1, fy0 + 1));
      const iAA = (yA * w + xA) * 4;
      const iBA = (yA * w + xB) * 4;
      const iAB = (yB * w + xA) * 4;
      const iBB = (yB * w + xB) * 4;
      const wAA = (1 - rx) * (1 - ry);
      const wBA = rx * (1 - ry);
      const wAB = (1 - rx) * ry;
      const wBB = rx * ry;
      const aAA = sd[iAA + 3];
      const aBA = sd[iBA + 3];
      const aAB = sd[iAB + 3];
      const aBB = sd[iBB + 3];
      const a = wAA * aAA + wBA * aBA + wAB * aAB + wBB * aBB;
      const o = (y * w + x) * 4;
      if (a <= 0) {
        od[o + 3] = 0;
        continue;
      }
      const inv = 1 / a;
      od[o] = (wAA * aAA * sd[iAA] + wBA * aBA * sd[iBA] + wAB * aAB * sd[iAB] + wBB * aBB * sd[iBB]) * inv;
      od[o + 1] = (wAA * aAA * sd[iAA + 1] + wBA * aBA * sd[iBA + 1] + wAB * aAB * sd[iAB + 1] + wBB * aBB * sd[iBB + 1]) * inv;
      od[o + 2] = (wAA * aAA * sd[iAA + 2] + wBA * aBA * sd[iBA + 2] + wAB * aAB * sd[iAB + 2] + wBB * aBB * sd[iBB + 2]) * inv;
      od[o + 3] = a;
    }
  }
  ctx.putImageData(out, sx, sy);
}

/** 実効方向: パネル設定 (state.bloatDir) × Alt 一時反転 */
function bloatSign(alt: boolean): 1 | -1 {
  return state.bloatDir * (alt ? -1 : 1) < 0 ? -1 : 1;
}

/* --- ホールド中の連続変形 (押し続けている間、カーソル位置でゆっくり変形し続ける) --- */
/** 1 秒押し続けたときの引き寄せ率 (強さスライダーで比例) */
const BLOAT_HOLD_RATE = 0.42;
let bloatHoldRaf = 0;
let bloatHoldLast = 0;
/** 最後にスタンプした位置 (rAF フレーム間の移動を補間するため保持) */
let bloatHoldPos: { x: number; y: number } | null = null;
/** Alt キーの押下状態 (rAF ループ内ではイベントが取れないため追跡) */
let altKeyDown = false;

function bloatHoldTick(now: number): void {
  const at = retouchLast;
  if (!at || state.tool !== "bloat") {
    bloatHoldRaf = 0;
    bloatHoldPos = null;
    return;
  }
  const dt = Math.min(0.1, (now - bloatHoldLast) / 1000);
  bloatHoldLast = now;
  // 前回適用位置 → 現在位置をブラシ径の 1/4 間隔で補間 (素早く動かしても塗り残しが出ないように)
  const from = bloatHoldPos ?? at;
  const dist = Math.hypot(at.x - from.x, at.y - from.y);
  const step = Math.max(1, state.brushSize * 0.25);
  const n = Math.max(1, Math.ceil(dist / step));
  // 合計の適用率が常に時間比例 (BLOAT_HOLD_RATE × dt) になるよう 1 スタンプ分ずつ配分する
  const pull = Math.min(BLOAT_PULL, (BLOAT_HOLD_RATE * dt) / n);
  if (pull > 0.0005) {
    const sign = bloatSign(altKeyDown);
    editTargets().forEach((l) => {
      for (let i = 1; i <= n; i++) {
        bloatStamp(l, { x: from.x + ((at.x - from.x) * i) / n, y: from.y + ((at.y - from.y) * i) / n }, sign, pull);
      }
    });
    render();
  }
  bloatHoldPos = at;
  bloatHoldRaf = requestAnimationFrame(bloatHoldTick);
}

function startBloatHold(): void {
  bloatHoldLast = performance.now();
  bloatHoldPos = null;
  if (bloatHoldRaf) cancelAnimationFrame(bloatHoldRaf);
  bloatHoldRaf = requestAnimationFrame(bloatHoldTick);
}

function stopBloatHold(): void {
  if (bloatHoldRaf) cancelAnimationFrame(bloatHoldRaf);
  bloatHoldRaf = 0;
}

/** ストロークをブラシ幅の 1/4 間隔で補間しながらスタンプを並べる */
function retouchStroke(
  stamp: (from: { x: number; y: number }, to: { x: number; y: number }) => void,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const step = Math.max(1, state.brushSize * 0.25);
  const n = Math.max(1, Math.ceil(dist / step));
  let prev = from;
  for (let i = 1; i <= n; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n };
    stamp(prev, p);
    prev = p;
  }
}

/* ============ フィルターペン (なぞった範囲にフィルターを焼き込む) ============ */
/** ドラッグ中の最後の座標 */
let filterPenLast: { x: number; y: number } | null = null;
/** ストローク開始時の対象レイヤースナップショット。基準画像を固定することで、同一ストローク内で重ね塗りしてもフィルターが二重に効かない */
const filterPenBase = new Map<number, HTMLCanvasElement>();
/** ペンでなぞった領域の累積マスク (白 = 適用済み) */
const filterPenMask = document.createElement("canvas");
filterPenMask.width = DOC_W;
filterPenMask.height = DOC_H;
const filterPenMaskCtx = filterPenMask.getContext("2d")!;

/**
 * セグメント (from→to) をペンマスクに追記し、その bbox に対して
 * 「ストローク開始時スナップショット + 現在のフィルター設定」を焼き込む。
 * 効果の基準はストローク開始時の画像なので、なぞり直してもフィルター強度は一定
 * (確定前のフィルタープレビューとは独立に、ピクセルへ直接適用される)。
 */
function applyFilterPenSegment(from: { x: number; y: number }, to: { x: number; y: number }): void {
  const targets = editTargets();
  if (!targets.length) return;
  // ぼかしのはみ出し分 (blur radius) も bbox に含める
  const blurPad = filters.on.blur && filters.blur > 0 ? filters.blur : 0;
  const pad = state.brushSize / 2 + 2 + blurPad;
  const bx = Math.max(0, Math.floor(Math.min(from.x, to.x) - pad));
  const by = Math.max(0, Math.floor(Math.min(from.y, to.y) - pad));
  const br = Math.min(DOC_W, Math.ceil(Math.max(from.x, to.x) + pad));
  const bb = Math.min(DOC_H, Math.ceil(Math.max(from.y, to.y) + pad));
  const bw = br - bx;
  const bh = bb - by;
  if (bw <= 0 || bh <= 0) return;

  // 1) ペンマスクにセグメントを追記 (累積)
  filterPenMaskCtx.save();
  filterPenMaskCtx.strokeStyle = "#fff";
  filterPenMaskCtx.lineWidth = state.brushSize;
  filterPenMaskCtx.lineCap = "round";
  filterPenMaskCtx.lineJoin = "round";
  drawLineSeg(filterPenMaskCtx, from, to);
  filterPenMaskCtx.restore();

  // 2) bbox: スナップショットにフィルターをかけ、選択範囲 → ペンマスクの順で切り抜いて対象レイヤーへ合成
  ensureStrokeTmp(bw, bh);
  const tg = strokeTmpCtx;
  for (const l of targets) {
    const base = filterPenBase.get(l.id);
    if (!base) continue;
    tg.save();
    tg.translate(-bx, -by);
    tg.globalCompositeOperation = "source-over";
    tg.clearRect(bx, by, bw, bh);
    tg.filter = filterString();
    tg.drawImage(base, 0, 0);
    tg.filter = "none";
    if (filters.on.noise && filters.noise > 0) drawNoise(tg);
    tg.globalCompositeOperation = "destination-in";
    if (hasSelection) {
      tg.drawImage(selMask, 0, 0);
    }
    tg.drawImage(filterPenMask, 0, 0);
    tg.restore();
    l.ctx.save();
    l.ctx.globalAlpha = state.opacity / 100;
    l.ctx.drawImage(strokeTmp, bx, by);
    l.ctx.restore();
  }
}

/* ============ ポインタ操作 ============ */
let strokeLast: { x: number; y: number } | null = null;
let panning: { sx: number; sy: number } | null = null;
let dragStart: { x: number; y: number } | null = null;

function localPos(e: PointerEvent | MouseEvent): { x: number; y: number } {
  const r = view.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function drawLineSeg(ctx: CanvasRenderingContext2D, a: { x: number; y: number }, b: { x: number; y: number }): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function setupStrokeStyle(ctx: CanvasRenderingContext2D): void {
  ctx.globalAlpha = state.opacity / 100;
  if (state.tool === "eraser") ctx.globalCompositeOperation = "destination-out";
  ctx.strokeStyle = state.fg;
  ctx.fillStyle = state.fg;
  ctx.lineWidth = state.brushSize;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

/* ============ 選択範囲クリップ描画 (選択中はその範囲のみ描画) ============ */
/** ストロークを選択範囲で切り抜くための作業canvas (GC負荷軽減のため再利用) */
const strokeTmp = document.createElement("canvas");
const strokeTmpCtx = strokeTmp.getContext("2d")!;

function ensureStrokeTmp(w: number, h: number): void {
  if (strokeTmp.width !== w || strokeTmp.height !== h) {
    strokeTmp.width = w;
    strokeTmp.height = h;
  } else {
    strokeTmpCtx.clearRect(0, 0, w, h);
  }
}

/**
 * レイヤーへストロークを合成する。
 * 選択範囲がなければ従来どおり直接描画し、あれば
 * 「作業canvasに不透明でストロークを描く → selMask で切り抜き → 不透明度を効かせてレイヤーへ合成」
 * の順で処理することで、選択範囲の外側には一切描画されない。
 * draw: 実際の描画処理。(x0,y0)-(x1,y1) はストロークbbox (doc座標)、pad は線幅等のマージン。
 */
function paintStroke(
  ctx: CanvasRenderingContext2D,
  draw: (g: CanvasRenderingContext2D) => void,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  pad: number,
): void {
  if (!hasSelection) {
    ctx.save();
    setupStrokeStyle(ctx);
    draw(ctx);
    ctx.restore();
    return;
  }
  const bx = Math.max(0, Math.floor(Math.min(x0, x1) - pad));
  const by = Math.max(0, Math.floor(Math.min(y0, y1) - pad));
  const br = Math.min(DOC_W, Math.ceil(Math.max(x0, x1) + pad));
  const bb = Math.min(DOC_H, Math.ceil(Math.max(y0, y1) + pad));
  const bw = br - bx;
  const bh = bb - by;
  if (bw <= 0 || bh <= 0) return;
  ensureStrokeTmp(bw, bh);
  const tg = strokeTmpCtx;
  // 1) ストロークを不透明で描画 (消しゴムも作業canvas上では通常描画)
  tg.save();
  tg.translate(-bx, -by);
  setupStrokeStyle(tg);
  tg.globalAlpha = 1;
  tg.globalCompositeOperation = "source-over";
  draw(tg);
  tg.restore();
  // 2) 選択マスクで切り抜く
  tg.save();
  tg.globalCompositeOperation = "destination-in";
  tg.drawImage(selMask, -bx, -by);
  tg.restore();
  // 3) レイヤーへ合成 (不透明度はここで一度だけ効く。消しゴムは destination-out)
  ctx.save();
  ctx.globalAlpha = state.opacity / 100;
  if (state.tool === "eraser") ctx.globalCompositeOperation = "destination-out";
  ctx.drawImage(strokeTmp, bx, by);
  ctx.restore();
}

function onPointerDown(e: PointerEvent): void {
  if (e.button === 2) return;
  const s = localPos(e);
  const d = screenToDoc(s.x, s.y);
  view.setPointerCapture(e.pointerId);

  if (state.spacePan || state.tool === "pan" || e.button === 1) {
    panning = { sx: s.x - state.panX, sy: s.y - state.panY };
    stage.classList.add("is-panning");
    return;
  }

  switch (state.tool) {
    case "brush":
    case "eraser": {
      pushUndo();
      markDirty();
      editTargets().forEach((l) => paintStroke(l.ctx, (g) => drawLineSeg(g, d, d), d.x, d.y, d.x, d.y, state.brushSize / 2 + 2));
      strokeLast = d;
      break;
    }
    case "smudge":
    case "bloat":
    case "dodge":
    case "burn": {
      pushUndo();
      markDirty();
      if (state.tool === "bloat") {
        // クリック時のフィードバックとして 0.25 秒分の控えめな膨張を 1 回適用し、
        // 以降の適用は rAF ホールドループ (時間ベース) に一任する
        editTargets().forEach((l) => bloatStamp(l, d, bloatSign(e.altKey), BLOAT_HOLD_RATE * 0.25));
        startBloatHold();
      } else if (state.tool !== "smudge") {
        const mode = toneMode(e.altKey);
        editTargets().forEach((l) => toneStamp(l, mode, d));
      }
      retouchLast = d;
      break;
    }
    case "filter-pen": {
      if (!filtersActive()) {
        toast("先にフィルタータブでフィルターを有効にしてください", "info");
        break;
      }
      pushUndo();
      markDirty();
      filterPenBase.clear();
      editTargets().forEach((l) => filterPenBase.set(l.id, clone(l.canvas)));
      filterPenMaskCtx.clearRect(0, 0, DOC_W, DOC_H);
      applyFilterPenSegment(d, d);
      filterPenLast = d;
      break;
    }
    case "line":
    case "rect":
    case "ellipse":
    case "select-rect":
      dragStart = d;
      preview = { tool: state.tool, x0: d.x, y0: d.y, x1: d.x, y1: d.y };
      break;
    case "lasso":
      lassoPath = [d];
      break;
    case "polygon":
      // クリック=頂点追加 / ドラッグ=フリーハンド。判別は pointerup で行う
      polyDrag = { pts: [d], moved: false };
      polyHover = d;
      break;
    case "mask-pen": {
      pushUndo();
      markDirty();
      const mode = dragMods ?? state.selMode;
      if (mode === "new") selCtx.clearRect(0, 0, DOC_W, DOC_H);
      selCtx.save();
      selCtx.globalCompositeOperation = mode === "sub" ? "destination-out" : "source-over";
      selCtx.strokeStyle = "#fff";
      selCtx.lineWidth = state.brushSize;
      selCtx.lineCap = "round";
      selCtx.lineJoin = "round";
      drawLineSeg(selCtx, d, d);
      selCtx.restore();
      maskStroke = { mode, last: d };
      break;
    }
    case "bucket": {
      const m = floodMask(d.x, d.y, state.tolerance);
      if (hasSelection) {
        // 選択範囲がある場合は選択範囲との交差部分のみを塗る
        const mg = m.getContext("2d")!;
        mg.globalCompositeOperation = "destination-in";
        mg.drawImage(selMask, 0, 0);
        mg.globalCompositeOperation = "source-over";
      }
      tintMask(m, state.fg);
      pushUndo();
      editTargets().forEach((l) => {
        l.ctx.save();
        setupStrokeStyle(l.ctx);
        l.ctx.drawImage(m, 0, 0);
        l.ctx.restore();
      });
      markDirty();
      break;
    }
    case "wand": {
      const m = floodMask(d.x, d.y, state.tolerance);
      applySelection((g) => g.drawImage(m, 0, 0));
      toast(`類似色範囲を選択 (許容度 ${state.tolerance})`, "info");
      break;
    }
    case "eyedropper": {
      const c = pickColor(d.x, d.y);
      if (c) {
        state.fg = c;
        ($("#swatch-fg") as HTMLButtonElement).style.background = c;
        ($("#color-input") as HTMLInputElement).value = c;
        toast(`色を取得: ${c.toUpperCase()}`, "ok");
      }
      break;
    }
    default:
      break;
  }
  render();
}

function onPointerMove(e: PointerEvent): void {
  const s = localPos(e);
  const d = screenToDoc(s.x, s.y);
  cursorPos = d;

  const inside = d.x >= 0 && d.y >= 0 && d.x < DOC_W && d.y < DOC_H;
  $("#st-pos").textContent = inside ? `X: ${Math.floor(d.x)}  Y: ${Math.floor(d.y)}` : "X: —  Y: —";

  if (panning) {
    state.panX = s.x - panning.sx;
    state.panY = s.y - panning.sy;
  } else if (strokeLast) {
    const from = strokeLast;
    editTargets().forEach((l) => paintStroke(l.ctx, (g) => drawLineSeg(g, from, d), from.x, from.y, d.x, d.y, state.brushSize / 2 + 2));
    strokeLast = d;
  } else if (retouchLast) {
    if (state.tool === "bloat") {
      // 膨張の適用は rAF ホールドループ (時間ベース) に一任し、ここでは位置追従のみ行う。
      // ここでスタンプすると mouse の micro-move (125-1000Hz) ごとに全強度スタンプが発射し、
      // 押しっぱなし中の手ブレ方向 (多くは左上) へ画像が激しく引っ張られてしまう
      retouchLast = d;
    } else {
      const from = retouchLast;
      editTargets().forEach((l) => {
        if (state.tool === "smudge") retouchStroke((f, t) => smudgeStamp(l, f, t), from, d);
        else retouchStroke((_f, t) => toneStamp(l, toneMode(e.altKey), t), from, d);
      });
      retouchLast = d;
    }
  } else if (filterPenLast) {
    applyFilterPenSegment(filterPenLast, d);
    filterPenLast = d;
  } else if (preview && dragStart) {
    let { x, y } = d;
    if (e.shiftKey) {
      const dx = x - dragStart.x;
      const dy = y - dragStart.y;
      if (preview.tool === "line") {
        if (Math.abs(dx) > Math.abs(dy) * 2) y = dragStart.y;
        else if (Math.abs(dy) > Math.abs(dx) * 2) x = dragStart.x;
        else {
          const m = Math.min(Math.abs(dx), Math.abs(dy));
          x = dragStart.x + Math.sign(dx) * m;
          y = dragStart.y + Math.sign(dy) * m;
        }
      } else {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        x = dragStart.x + Math.sign(dx || 1) * m;
        y = dragStart.y + Math.sign(dy || 1) * m;
      }
    }
    preview.x1 = x;
    preview.y1 = y;
  } else if (lassoPath) {
    const lastP = lassoPath[lassoPath.length - 1];
    if (Math.hypot(d.x - lastP.x, d.y - lastP.y) * state.zoom > 2) lassoPath.push(d);
  } else if (maskStroke) {
    selCtx.save();
    selCtx.globalCompositeOperation = maskStroke.mode === "sub" ? "destination-out" : "source-over";
    selCtx.strokeStyle = "#fff";
    selCtx.lineWidth = state.brushSize;
    selCtx.lineCap = "round";
    selCtx.lineJoin = "round";
    drawLineSeg(selCtx, maskStroke.last, d);
    selCtx.restore();
    maskStroke.last = d;
  } else if (polyDrag) {
    // ドラッグ中は投げ縄のように連続頂点を収集
    const lastP = polyDrag.pts[polyDrag.pts.length - 1];
    if (Math.hypot(d.x - lastP.x, d.y - lastP.y) * state.zoom > 3) {
      polyDrag.pts.push(d);
      polyDrag.moved = true;
    }
    polyHover = d;
  } else if (state.tool === "polygon" && polyPoints.length > 0) {
    polyHover = d;
  }
  render();
}

function onPointerUp(): void {
  panning = null;
  stage.classList.remove("is-panning");

  // 図形 / 矩形選択の確定
  if (preview && dragStart) {
    const p = { ...preview };
    preview = null;
    if (p.tool === "select-rect") {
      const x = Math.min(p.x0, p.x1);
      const y = Math.min(p.y0, p.y1);
      const w = Math.abs(p.x1 - p.x0);
      const h = Math.abs(p.y1 - p.y0);
      if (w > 2 && h > 2) applySelection((g) => g.fillRect(x, y, w, h));
    } else {
      pushUndo();
      markDirty();
      const px0 = Math.min(p.x0, p.x1);
      const py0 = Math.min(p.y0, p.y1);
      const px1 = Math.max(p.x0, p.x1);
      const py1 = Math.max(p.y0, p.y1);
      const lwPad = state.brushSize / 2 + 2;
      editTargets().forEach((l) => {
        const ctx = l.ctx;
        if (p.tool === "line") {
          paintStroke(ctx, (g) => drawLineSeg(g, { x: p.x0, y: p.y0 }, { x: p.x1, y: p.y1 }), p.x0, p.y0, p.x1, p.y1, lwPad);
        } else if (p.tool === "rect") {
          paintStroke(
            ctx,
            (g) => {
              if (state.fillShape) g.fillRect(px0, py0, px1 - px0, py1 - py0);
              else g.strokeRect(px0, py0, px1 - px0, py1 - py0);
            },
            px0, py0, px1, py1,
            state.fillShape ? 1 : lwPad,
          );
        } else if (p.tool === "ellipse") {
          paintStroke(
            ctx,
            (g) => {
              g.beginPath();
              g.ellipse((p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, Math.abs(p.x1 - p.x0) / 2, Math.abs(p.y1 - p.y0) / 2, 0, 0, Math.PI * 2);
              if (state.fillShape) g.fill();
              else g.stroke();
            },
            px0, py0, px1, py1,
            state.fillShape ? 1 : lwPad,
          );
        }
      });
    }
  }

  // 投げ縄の確定
  if (lassoPath) {
    const pts = lassoPath;
    lassoPath = null;
    if (pts.length > 2) {
      applySelection((g) => {
        g.beginPath();
        g.moveTo(pts[0].x, pts[0].y);
        for (const p of pts) g.lineTo(p.x, p.y);
        g.closePath();
        g.fill();
      });
    }
  }

  // 選択ペンのストローク確定 → Marching ants を更新
  if (maskStroke) {
    maskStroke = null;
    hasSelection = selHasContent();
    rebuildAnts();
    syncToolGuide();
  }

  // 多角形: クリック=頂点追加 / ドラッグ=フリーハンド連結
  if (polyDrag) {
    const drag = polyDrag;
    polyDrag = null;
    if (!drag.moved) {
      // クリック: 始点近傍なら閉じる、そうでなければ頂点を追加
      const d = drag.pts[0];
      const nearStart = polyPoints.length > 2 && Math.hypot(d.x - polyPoints[0].x, d.y - polyPoints[0].y) * state.zoom < 10;
      if (nearStart) closePolygon();
      else polyPoints.push(d);
    } else {
      for (const p of drag.pts) {
        const lp = polyPoints[polyPoints.length - 1];
        if (!lp || Math.hypot(p.x - lp.x, p.y - lp.y) * state.zoom > 1.5) polyPoints.push(p);
      }
    }
    polyHover = null;
  }

  stopBloatHold();
  strokeLast = null;
  retouchLast = null;
  filterPenLast = null;
  filterPenBase.clear();
  dragStart = null;
  render();
}

function closePolygon(): void {
  const pts = polyPoints;
  polyPoints = [];
  polyDrag = null;
  polyHover = null;
  if (pts.length >= 3) {
    applySelection((g) => {
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (const p of pts) g.lineTo(p.x, p.y);
      g.closePath();
      g.fill();
    });
    toast(`多角形選択を確定 (${pts.length}頂点)`, "ok");
  }
  render();
}

function cancelPolygon(): void {
  if (polyPoints.length > 0 || polyDrag) {
    polyPoints = [];
    polyDrag = null;
    polyHover = null;
    render();
    toast("多角形選択を取消", "info");
  }
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const s = localPos(e);
  if (e.ctrlKey || !e.shiftKey) {
    const factor = Math.exp(-e.deltaY * 0.0015);
    setZoom(state.zoom * factor, s.x, s.y);
  } else {
    state.panX -= e.deltaX;
    state.panY -= e.deltaY;
    render();
  }
}

/* ============ UI配線: ツール / パネル ============ */
const TOOL_ICON: Record<ToolId, string> = {
  brush: "brush", eraser: "eraser", bucket: "bucket",
  smudge: "smudge", bloat: "bloat", dodge: "sun", burn: "moon", "filter-pen": "sparkles",
  line: "line", rect: "square", ellipse: "circle",
  "select-rect": "box-select", lasso: "lasso", polygon: "pentagon", wand: "wand", "mask-pen": "pen",
  eyedropper: "pipette", pan: "hand",
};

let dragMods: SelMode | null = null;

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

/** 選択範囲の影響を受ける描画系ツール */
const PAINT_TOOLS: ToolId[] = ["brush", "eraser", "bucket", "smudge", "bloat", "dodge", "burn", "filter-pen", "line", "rect", "ellipse"];

/** ステータスバーの操作ガイドを更新 (選択中は「範囲内のみ」・複数対象時は「N レイヤーに適用」注記を添える) */
function syncToolGuide(): void {
  const selNote = hasSelection && PAINT_TOOLS.includes(state.tool) ? " · 選択範囲内のみ描画" : "";
  const targets = editTargets().length;
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
  $("#brush-preview-label").textContent = `⌀ ${state.brushSize} px`;
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
  for (const key of Object.keys(filters.on)) {
    const box = $(`input[data-fx-on="${key}"]`) as HTMLInputElement;
    const range = $(`input[data-fx-range="${key}"]`) as HTMLInputElement;
    const val = $(`[data-fx-val="${key}"]`);
    box.checked = filters.on[key];
    range.value = String(filters[key as keyof typeof filters]);
    paintRangeFill(range);
    val.textContent = FX_FORMAT[key]((filters[key as keyof typeof filters] as number));
    ($(`.fx[data-fx="${key}"]`) as HTMLElement).classList.toggle("is-on", filters.on[key]);
  }
  // ノイズの種類 (カラー / グレー) ボタンの反映
  $$("button[data-fx-noise-mode]").forEach((b) =>
    b.classList.toggle("is-active", (b as HTMLElement).dataset.fxNoiseMode === filters.noiseMode),
  );
}

/**
 * フィルターを確定(ベイク): 現在のフィルター結果を背景レイヤーのピクセルに焼き込み、
 * フィルター設定をリセットする。選択範囲がある場合はその範囲のみ焼き込む。
 */
function bakeFilters(): void {
  const base = layers.find((l) => l.kind === "base");
  if (!base || !filtersActive()) {
    toast("有効なフィルターがありません", "info");
    return;
  }
  pushUndo(base);

  // 1) フィルター適用済み画像を作る
  const filtered = document.createElement("canvas");
  filtered.width = DOC_W;
  filtered.height = DOC_H;
  const fg = filtered.getContext("2d")!;
  fg.filter = filterString();
  fg.drawImage(base.canvas, 0, 0);
  fg.filter = "none";
  if (filters.on.noise && filters.noise > 0) drawNoise(fg);

  // 2) 背景レイヤーに焼き込む(選択範囲があればその範囲のみ)
  if (hasSelection) {
    const masked = document.createElement("canvas");
    masked.width = DOC_W;
    masked.height = DOC_H;
    const mg = masked.getContext("2d")!;
    mg.drawImage(filtered, 0, 0);
    mg.globalCompositeOperation = "destination-in";
    mg.drawImage(selMask, 0, 0);
    mg.globalCompositeOperation = "source-over";
    base.ctx.drawImage(masked, 0, 0);
  } else {
    base.ctx.clearRect(0, 0, DOC_W, DOC_H);
    base.ctx.drawImage(filtered, 0, 0);
  }

  // 3) フィルター設定をリセット
  Object.keys(filters.on).forEach((k) => (filters.on[k] = false));
  filters.blur = 0;
  filters.noise = 0;
  filters.noiseMode = "color";
  filters.brightness = 100;
  filters.contrast = 100;
  filters.saturate = 100;
  filters.hue = 0;
  syncFilterUI();
  renderLayers();
  markDirty();
  render();
  toast(hasSelection ? "選択範囲にフィルターを確定しました" : "フィルターを確定しました(ベイク)", "fx");
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
      (filters[key as keyof typeof filters] as number) = Number((el as HTMLInputElement).value);
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
  $("#btn-filter-apply").addEventListener("click", bakeFilters);
  $("#btn-filter-reset").addEventListener("click", () => {
    Object.keys(filters.on).forEach((k) => (filters.on[k] = false));
    filters.blur = 0;
    filters.noise = 0;
    filters.noiseMode = "color";
    filters.brightness = 100;
    filters.contrast = 100;
    filters.saturate = 100;
    filters.hue = 0;
    syncFilterUI();
    render();
    toast("フィルターをリセット", "fx");
  });
}

/* ---------- レイヤー ---------- */
function layerBadgeHTML(l: Layer): string {
  let html = "";
  // 編集対象バッジ (アクティブレイヤー以外の追加対象に表示)
  if (editTargetIds.has(l.id) && l.id !== activeLayerId) {
    html += `<span class="layer__badge layer__badge--target" title="編集対象 (Ctrl+クリックで解除)"><i data-icon="link"></i>編集</span>`;
  }
  if (l.kind === "base") {
    const fxOn = Object.values(filters.on).some(Boolean);
    html += `<span class="layer__badge layer__badge--lock"><i data-icon="lock"></i></span>${fxOn ? '<span class="layer__badge layer__badge--fx">FX</span>' : ""}`;
  }
  return html;
}

/** レイヤーリストのクリック: 通常クリック=アクティブ切替 (編集対象をリセット) / Ctrl+クリック=編集対象へ追加・解除 */
function selectLayer(l: Layer, additive: boolean): void {
  if (additive) {
    if (l.id === activeLayerId) return; // アクティブレイヤーは常に編集対象
    if (editTargetIds.has(l.id)) {
      editTargetIds.delete(l.id);
      toast(`「${l.name}」を編集対象から解除`, "info");
    } else {
      editTargetIds.add(l.id);
      toast(`「${l.name}」を編集対象に追加 (${editTargets().length} 対象)`, "ok");
    }
  } else if (l.id !== activeLayerId || editTargetIds.size > 1) {
    const wasMulti = editTargets().length > 1;
    activeLayerId = l.id;
    editTargetIds = new Set([l.id]);
    if (wasMulti) toast(`編集対象を「${l.name}」のみにリセット`, "info");
  }
  renderLayers();
  syncToolGuide();
}

function renderLayers(): void {
  const list = $("#layer-list");
  list.innerHTML = "";
  [...layers].reverse().forEach((l) => {
    const li = document.createElement("li");
    li.className = `layer${l.id === activeLayerId ? " is-active" : ""}${editTargetIds.has(l.id) ? " is-target" : ""}${l.visible ? "" : " is-hidden-layer"}`;
    li.innerHTML = `
      <div class="layer__thumb"></div>
      <div class="layer__meta">
        <div class="layer__name">${l.name} ${layerBadgeHTML(l)}</div>
        <div class="layer__sub">${l.kind === "base" ? "元画像 · 前処理フィルター適用" : "640 × 640 · normal"}</div>
      </div>
      <button class="layer__eye" title="表示 / 非表示"><i data-icon="${l.visible ? "eye" : "eye-off"}"></i></button>`;
    (li.querySelector(".layer__thumb") as HTMLElement).appendChild(cloneThumb(l.canvas));
    li.addEventListener("click", (e) => selectLayer(l, e.ctrlKey || e.metaKey || e.shiftKey));
    (li.querySelector(".layer__eye") as HTMLElement).addEventListener("click", (e) => {
      e.stopPropagation();
      l.visible = !l.visible;
      renderLayers();
      render();
    });
    list.appendChild(li);
  });
  mountIcons(list);
  $("#layer-count").textContent = String(layers.length);
  $("#layer-target-count").textContent = String(editTargets().length);
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

function addLayer(copy?: Layer): void {
  const l = copy
    ? makeLayer(`${copy.name} copy`, "paint")
    : makeLayer(`Layer ${layers.filter((x) => x.kind === "paint").length + 1}`, "paint");
  if (copy) l.ctx.drawImage(copy.canvas, 0, 0);
  layers.push(l);
  activeLayerId = l.id;
  editTargetIds = new Set([l.id]);
  renderLayers();
  toast(`レイヤー「${l.name}」を追加`, "ok");
}

function bindLayers(): void {
  $("#btn-layer-add").addEventListener("click", () => addLayer());
  $("#btn-layer-dup").addEventListener("click", () => {
    const l = activeLayer();
    if (l.kind === "paint") addLayer(l);
    else toast("背景レイヤーは複製できません", "info");
  });
  $("#btn-layer-del").addEventListener("click", () => {
    const l = activeLayer();
    const paints = layers.filter((x) => x.kind === "paint");
    if (l.kind === "base") toast("背景レイヤーは削除できません", "info");
    else if (paints.length <= 1) toast("ペイントレイヤーは最低1枚必要です", "info");
    else {
      layers = layers.filter((x) => x.id !== l.id);
      activeLayerId = layers.filter((x) => x.kind === "paint").at(-1)!.id;
      editTargetIds = new Set([activeLayerId]);
      renderLayers();
      render();
      toast(`レイヤー「${l.name}」を削除`, "ok");
    }
  });
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
  for (const l of layers) {
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
  if (hasSelection) g.drawImage(selMask, 0, 0);
  return c.toDataURL("image/png");
}

function openExport(): void {
  cancelPolygon();
  exportCompositeUrl = compositeCanvas().toDataURL("image/png");
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
  $("#btn-undo").addEventListener("click", undo);
  $("#btn-redo").addEventListener("click", redo);
  $("#btn-zoomin").addEventListener("click", () => setZoom(state.zoom * 1.25));
  $("#btn-zoomout").addEventListener("click", () => setZoom(state.zoom / 1.25));
  $("#btn-zoom-label").addEventListener("click", () => setZoom(1));
  $("#btn-fit").addEventListener("click", fitView);
  $("#btn-export").addEventListener("click", openExport);

  $("#btn-cancel").addEventListener("click", () => {
    layers.filter((l) => l.kind === "paint").forEach((l) => l.ctx.clearRect(0, 0, DOC_W, DOC_H));
    clearSelection();
    Object.keys(filters.on).forEach((k) => (filters.on[k] = false));
    syncFilterUI();
    undoStack.length = 0;
    redoStack.length = 0;
    updateUndoButtons();
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
const KEY_TOOL: Record<string, ToolId> = {
  b: "brush", e: "eraser", g: "bucket",
  s: "smudge", v: "bloat", d: "dodge", j: "burn", f: "filter-pen",
  l: "line", u: "rect", o: "ellipse",
  m: "select-rect", q: "lasso", p: "polygon", w: "wand", k: "mask-pen",
  i: "eyedropper", h: "pan",
};

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

function onKeyDown(e: KeyboardEvent): void {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.key === "Alt") altKeyDown = true;
  const k = e.key.toLowerCase();

  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "a") { e.preventDefault(); selectAll(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "d") { e.preventDefault(); deselect(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); openExport(); return; }
  if (e.altKey && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); fillSelection(); return; }

  if (e.key === " ") { e.preventDefault(); state.spacePan = true; stage.style.cursor = "grab"; return; }
  if (e.key === "Escape") {
    if (!($("#modal-export") as HTMLElement).hidden) { closeExport(); return; }
    if (polyDrag || polyPoints.length > 0) { cancelPolygon(); return; }
    if (lassoPath) { lassoPath = null; render(); toast("投げ縄選択を取消", "info"); return; }
    if (preview || dragStart) { preview = null; dragStart = null; render(); return; }
    // 選択範囲をクリア
    if (hasSelection) deselect();
    return;
  }
  if (e.key === "Enter" && state.tool === "polygon") { closePolygon(); return; }
  if (e.key === "Delete" && hasSelection) {
    const targets = editTargets().filter((l) => l.kind === "paint");
    if (!targets.length) {
      toast("ペイントレイヤーを編集対象にしてください", "info");
      return;
    }
    pushUndo();
    targets.forEach((l) => {
      l.ctx.save();
      l.ctx.globalCompositeOperation = "destination-out";
      l.ctx.drawImage(selMask, 0, 0);
      l.ctx.restore();
    });
    markDirty();
    render();
    return;
  }

  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (KEY_TOOL[k]) { setTool(KEY_TOOL[k]); return; }
  if (k === "x") { swapColors(); return; }
  if (k === "[") { state.brushSize = Math.max(1, state.brushSize - Math.max(1, Math.round(state.brushSize * 0.15))); syncSlider(); return; }
  if (k === "]") { state.brushSize = Math.min(200, state.brushSize + Math.max(1, Math.round(state.brushSize * 0.15))); syncSlider(); return; }
  if (e.key === "+" || e.key === "=") { setZoom(state.zoom * 1.25); return; }
  if (e.key === "-") { setZoom(state.zoom / 1.25); return; }
  if (e.key === "0") { setZoom(1); return; }
  if (e.key === "1") { fitView(); return; }
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.key === "Alt") altKeyDown = false;
  if (e.key === " ") {
    state.spacePan = false;
    stage.style.cursor = TOOLS[state.tool].cursor;
  }
}

/* ============ エントリポイント ============ */
export function startApp(): void {
  mountIcons();

  layers = [makeLayer("背景 (元画像)", "base", createDemoImage())];
  const l1 = makeLayer("Layer 1", "paint");
  layers.push(l1);
  activeLayerId = l1.id;
  editTargetIds = new Set([l1.id]);

  resizeView();
  fitView();
  renderLayers();
  updateUndoButtons();
  updateColorUI();
  syncBrushPreview();
  syncFilterUI();
  setTool("brush");
  startAntLoop();

  // キャンバスイベント
  view.addEventListener(
    "pointerdown",
    (e) => {
      dragMods = e.shiftKey ? "add" : e.altKey ? "sub" : null;
      onPointerDown(e);
    },
  );
  view.addEventListener("pointermove", onPointerMove);
  view.addEventListener("pointerup", onPointerUp);
  view.addEventListener("pointercancel", onPointerUp);
  view.addEventListener("pointerleave", () => {
    cursorPos = null;
    $("#st-pos").textContent = "X: —  Y: —";
    render();
  });
  view.addEventListener("wheel", onWheel, { passive: false });
  view.addEventListener("contextmenu", (e) => e.preventDefault());
  view.addEventListener("dblclick", () => {
    if (state.tool === "polygon") closePolygon();
  });

  window.addEventListener("resize", resizeView);
  new ResizeObserver(resizeView).observe(workspace);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  bindControls();
  bindTabs();
  bindFilters();
  bindLayers();
  bindHeaderAndModal();
}
