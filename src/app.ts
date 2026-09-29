/**
 * app.ts — JSPaint UI モック本体
 * Photoshop/Figma ライクな Inpainting 前処理ペイントの動作デモ。
 *
 * リファクタリング進行中: 型 / ツール定義 / キャンバスユーティリティ / UI 補助は
 * core/ ui/ assets/ へ分離済み (ストア・描画・ツール・入力は後続ステップで分割)。
 */
import { mountIcons } from "./assets/icons";
import { createDemoImage } from "./assets/demo";
import { DOC_H, DOC_W } from "./core/types";
import type { Layer, SelMode, ToolId } from "./core/types";
import { state } from "./core/editorState";
import { CIRCLE_CURSOR_TOOLS, KEY_TOOL, PAINT_TOOLS, TOOLS, TOOL_ICON } from "./core/toolDefs";
import { clone, floodMask, hexA, roundRectPath, tintMask } from "./core/canvasUtils";
import { doc } from "./core/documentStore";
import { selection } from "./core/selectionStore";
import { history } from "./core/historyStack";
import { filters } from "./core/filterEngine";
import { setHooks } from "./core/hooks";
import { interaction } from "./core/interactionState";
import { docToScreenX, docToScreenY, fitView, screenToDoc, setZoom, viewport } from "./core/viewState";
import { deleteSelectionContents, deselect, fillSelection, selectAll } from "./core/selectionOps";
import { $, $$ } from "./ui/dom";
import { markDirty, toast } from "./ui/feedback";

/* ============ DOM ============ */
const view = $("#view") as HTMLCanvasElement;
const vctx = view.getContext("2d")!;
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

/* ============ レンダリング ============ */

function resizeView(): void {
  viewport.vw = workspace.clientWidth;
  viewport.vh = workspace.clientHeight;
  view.width = Math.max(1, Math.round(viewport.vw * viewport.dpr));
  view.height = Math.max(1, Math.round(viewport.vh * viewport.dpr));
  view.style.width = `${viewport.vw}px`;
  view.style.height = `${viewport.vh}px`;
  render();
}

function render(): void {
  if (!viewport.vw) return;
  vctx.setTransform(viewport.dpr, 0, 0, viewport.dpr, 0, 0);
  vctx.clearRect(0, 0, viewport.vw, viewport.vh);

  vctx.save();
  vctx.translate(viewport.vw / 2 + state.panX, viewport.vh / 2 + state.panY);
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
  filters.drawBaseLayer(vctx);

  // ペイントレイヤー (下 → 上)
  for (const l of doc.layers) {
    if (l.kind === "paint" && l.visible) vctx.drawImage(l.canvas, 0, 0);
  }

  drawStrokePreview(vctx);
  drawSelectionPreview(vctx);

  vctx.restore();

  // ドラッグ中のサイズ表示 (矩形選択 / 図形)
  drawDragSizeBadge(vctx);

  // Marching ants (doc解像度のエッジ層を重ね描き)
  if (selection.hasSelection && selection.antsBlack) {
    vctx.save();
    vctx.translate(viewport.vw / 2 + state.panX, viewport.vh / 2 + state.panY);
    vctx.scale(state.zoom, state.zoom);
    vctx.translate(-DOC_W / 2, -DOC_H / 2);
    vctx.imageSmoothingEnabled = false;
    vctx.drawImage(selection.antsBlack, 0, 0);
    vctx.drawImage(selection.antsWhite[selection.antPhase % 4], 0, 0);
    vctx.restore();
  }

  drawCursor();
}

function drawStrokePreview(g: CanvasRenderingContext2D): void {
  if (!interaction.preview) return;
  const { x0, y0, x1, y1, tool } = interaction.preview;
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
  if (interaction.preview && interaction.preview.tool === "select-rect") {
    const { x0, y0, x1, y1 } = interaction.preview;
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    // モード色 (確定時の適用モードと対応): 新規=青 / 追加(Shift)=緑 / 除外(Alt)=赤
    const mode = interaction.dragMods ?? state.selMode;
    const tint = mode === "add" ? "34, 197, 94" : mode === "sub" ? "239, 68, 68" : "96, 165, 250";
    g.fillStyle = `rgba(${tint}, 0.28)`;
    g.fillRect(x, y, w, h);
    // 枠: どの背景でも見えるよう黒の下地線 + 白破線 (既存選択がある間は ants に合わせて破線が流れる)
    g.strokeStyle = "rgba(0, 0, 0, 0.8)";
    g.strokeRect(x, y, w, h);
    g.strokeStyle = "#fff";
    g.setLineDash([4 / state.zoom, 3 / state.zoom]);
    g.lineDashOffset = (-selection.antPhase * 2) / state.zoom;
    g.strokeRect(x, y, w, h);
  }

  if (interaction.lassoPath && interaction.lassoPath.length > 1) {
    g.strokeStyle = "#fff";
    g.setLineDash([4 / state.zoom, 3 / state.zoom]);
    g.beginPath();
    g.moveTo(interaction.lassoPath[0].x, interaction.lassoPath[0].y);
    for (const p of interaction.lassoPath) g.lineTo(p.x, p.y);
    g.stroke();
  }
  if (state.tool === "polygon" && (interaction.polyPoints.length > 0 || interaction.polyDrag)) {
    const pts = interaction.polyDrag ? interaction.polyPoints.concat(interaction.polyDrag.pts) : interaction.polyPoints;
    g.strokeStyle = "#fff";
    g.setLineDash([4 / state.zoom, 3 / state.zoom]);
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (const p of pts) g.lineTo(p.x, p.y);
    if (interaction.polyHover) g.lineTo(interaction.polyHover.x, interaction.polyHover.y);
    g.stroke();

    // 頂点ハンドル (確定済み頂点のみ。始点は緑ドット)
    interaction.polyPoints.forEach((p, i) => {
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
  if (!interaction.preview) return;
  const { tool, x0, y0, x1, y1 } = interaction.preview;
  let label: string;
  if (tool === "line") {
    label = `Len: ${Math.round(Math.hypot(x1 - x0, y1 - y0))} px`;
  } else {
    label = `W: ${Math.round(Math.abs(x1 - x0))}  H: ${Math.round(Math.abs(y1 - y0))}`;
  }
  // 矩形選択: モード修飾中 (Shift=追加 / Alt=除外) は先頭に記号を添える
  if (tool === "select-rect" && interaction.dragMods) {
    label = `${interaction.dragMods === "add" ? "＋" : "−"} ${label}`;
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
  bx = Math.min(Math.max(4, bx), viewport.vw - bw - 4);
  by = Math.min(Math.max(4, by), viewport.vh - bh - 4);
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

function drawCursor(): void {
  if (!interaction.cursorPos) return;
  if (!CIRCLE_CURSOR_TOOLS.includes(state.tool)) return;
  const r = Math.max(2, (state.brushSize * state.zoom) / 2);
  const x = docToScreenX(interaction.cursorPos.x);
  const y = docToScreenY(interaction.cursorPos.y);
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

/* ============ レタッチツール (指先 / 覆い焼き / 焼き込み) ============ */
/** レタッチは編集対象レイヤー (アクティブ + Ctrl+クリックで追加した対象) に直接作用する */

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
  if (selection.hasSelection) {
    // 選択範囲がある場合はスタンプを選択マスクで切り抜き、外側に効果が出ないようにする
    g.globalCompositeOperation = "destination-in";
    g.drawImage(selection.mask, Math.round(to.x - r), Math.round(to.y - r), size, size, 0, 0, size, size);
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
  const selD = selection.hasSelection ? selection.ctx.getImageData(sx, sy, w, h).data : null;
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
  const selD = selection.hasSelection ? selection.ctx.getImageData(sx, sy, w, h).data : null;
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

function bloatHoldTick(now: number): void {
  const at = interaction.retouchLast;
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
    const sign = bloatSign(interaction.altKey);
    doc.editTargets().forEach((l) => {
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
  const targets = doc.editTargets();
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
    tg.filter = filters.filterString();
    tg.drawImage(base, 0, 0);
    tg.filter = "none";
    if (filters.on.noise && filters.noise > 0) filters.drawNoise(tg);
    tg.globalCompositeOperation = "destination-in";
    if (selection.hasSelection) {
      tg.drawImage(selection.mask, 0, 0);
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
 * 「作業canvasに不透明でストロークを描く → selection.mask で切り抜き → 不透明度を効かせてレイヤーへ合成」
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
  if (!selection.hasSelection) {
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
  tg.drawImage(selection.mask, -bx, -by);
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
    interaction.panning = { sx: s.x - state.panX, sy: s.y - state.panY };
    stage.classList.add("is-panning");
    return;
  }

  switch (state.tool) {
    case "brush":
    case "eraser": {
      history.pushUndo();
      markDirty();
      doc.editTargets().forEach((l) => paintStroke(l.ctx, (g) => drawLineSeg(g, d, d), d.x, d.y, d.x, d.y, state.brushSize / 2 + 2));
      interaction.strokeLast = d;
      break;
    }
    case "smudge":
    case "bloat":
    case "dodge":
    case "burn": {
      history.pushUndo();
      markDirty();
      if (state.tool === "bloat") {
        // クリック時のフィードバックとして 0.25 秒分の控えめな膨張を 1 回適用し、
        // 以降の適用は rAF ホールドループ (時間ベース) に一任する
        doc.editTargets().forEach((l) => bloatStamp(l, d, bloatSign(e.altKey), BLOAT_HOLD_RATE * 0.25));
        startBloatHold();
      } else if (state.tool !== "smudge") {
        const mode = toneMode(e.altKey);
        doc.editTargets().forEach((l) => toneStamp(l, mode, d));
      }
      interaction.retouchLast = d;
      break;
    }
    case "filter-pen": {
      if (!filters.filtersActive()) {
        toast("先にフィルタータブでフィルターを有効にしてください", "info");
        break;
      }
      history.pushUndo();
      markDirty();
      filterPenBase.clear();
      doc.editTargets().forEach((l) => filterPenBase.set(l.id, clone(l.canvas)));
      filterPenMaskCtx.clearRect(0, 0, DOC_W, DOC_H);
      applyFilterPenSegment(d, d);
      interaction.filterPenLast = d;
      break;
    }
    case "line":
    case "rect":
    case "ellipse":
    case "select-rect":
      interaction.dragStart = d;
      interaction.preview = { tool: state.tool, x0: d.x, y0: d.y, x1: d.x, y1: d.y };
      break;
    case "lasso":
      interaction.lassoPath = [d];
      break;
    case "polygon":
      // クリック=頂点追加 / ドラッグ=フリーハンド。判別は pointerup で行う
      interaction.polyDrag = { pts: [d], moved: false };
      interaction.polyHover = d;
      break;
    case "mask-pen": {
      history.pushUndo();
      markDirty();
      const mode = interaction.dragMods ?? state.selMode;
      selection.beginMaskStroke(mode);
      selection.paintMaskSegment(d, d);
      interaction.maskStroke = { mode, last: d };
      break;
    }
    case "bucket": {
      const m = floodMask(doc.compositeCanvas(), d.x, d.y, state.tolerance);
      if (selection.hasSelection) {
        // 選択範囲がある場合は選択範囲との交差部分のみを塗る
        const mg = m.getContext("2d")!;
        mg.globalCompositeOperation = "destination-in";
        mg.drawImage(selection.mask, 0, 0);
        mg.globalCompositeOperation = "source-over";
      }
      tintMask(m, state.fg);
      history.pushUndo();
      doc.editTargets().forEach((l) => {
        l.ctx.save();
        setupStrokeStyle(l.ctx);
        l.ctx.drawImage(m, 0, 0);
        l.ctx.restore();
      });
      markDirty();
      break;
    }
    case "wand": {
      const m = floodMask(doc.compositeCanvas(), d.x, d.y, state.tolerance);
      selection.applySelection((g) => g.drawImage(m, 0, 0));
      toast(`類似色範囲を選択 (許容度 ${state.tolerance})`, "info");
      break;
    }
    case "eyedropper": {
      const c = doc.pickColor(d.x, d.y);
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
  interaction.cursorPos = d;

  const inside = d.x >= 0 && d.y >= 0 && d.x < DOC_W && d.y < DOC_H;
  $("#st-pos").textContent = inside ? `X: ${Math.floor(d.x)}  Y: ${Math.floor(d.y)}` : "X: —  Y: —";

  if (interaction.panning) {
    state.panX = s.x - interaction.panning.sx;
    state.panY = s.y - interaction.panning.sy;
  } else if (interaction.strokeLast) {
    const from = interaction.strokeLast;
    doc.editTargets().forEach((l) => paintStroke(l.ctx, (g) => drawLineSeg(g, from, d), from.x, from.y, d.x, d.y, state.brushSize / 2 + 2));
    interaction.strokeLast = d;
  } else if (interaction.retouchLast) {
    if (state.tool === "bloat") {
      // 膨張の適用は rAF ホールドループ (時間ベース) に一任し、ここでは位置追従のみ行う。
      // ここでスタンプすると mouse の micro-move (125-1000Hz) ごとに全強度スタンプが発射し、
      // 押しっぱなし中の手ブレ方向 (多くは左上) へ画像が激しく引っ張られてしまう
      interaction.retouchLast = d;
    } else {
      const from = interaction.retouchLast;
      doc.editTargets().forEach((l) => {
        if (state.tool === "smudge") retouchStroke((f, t) => smudgeStamp(l, f, t), from, d);
        else retouchStroke((_f, t) => toneStamp(l, toneMode(e.altKey), t), from, d);
      });
      interaction.retouchLast = d;
    }
  } else if (interaction.filterPenLast) {
    applyFilterPenSegment(interaction.filterPenLast, d);
    interaction.filterPenLast = d;
  } else if (interaction.preview && interaction.dragStart) {
    let { x, y } = d;
    if (e.shiftKey) {
      const dx = x - interaction.dragStart.x;
      const dy = y - interaction.dragStart.y;
      if (interaction.preview.tool === "line") {
        if (Math.abs(dx) > Math.abs(dy) * 2) y = interaction.dragStart.y;
        else if (Math.abs(dy) > Math.abs(dx) * 2) x = interaction.dragStart.x;
        else {
          const m = Math.min(Math.abs(dx), Math.abs(dy));
          x = interaction.dragStart.x + Math.sign(dx) * m;
          y = interaction.dragStart.y + Math.sign(dy) * m;
        }
      } else {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        x = interaction.dragStart.x + Math.sign(dx || 1) * m;
        y = interaction.dragStart.y + Math.sign(dy || 1) * m;
      }
    }
    interaction.preview.x1 = x;
    interaction.preview.y1 = y;
  } else if (interaction.lassoPath) {
    const lastP = interaction.lassoPath[interaction.lassoPath.length - 1];
    if (Math.hypot(d.x - lastP.x, d.y - lastP.y) * state.zoom > 2) interaction.lassoPath.push(d);
  } else if (interaction.maskStroke) {
    selection.paintMaskSegment(interaction.maskStroke.last, d);
    interaction.maskStroke.last = d;
  } else if (interaction.polyDrag) {
    // ドラッグ中は投げ縄のように連続頂点を収集
    const lastP = interaction.polyDrag.pts[interaction.polyDrag.pts.length - 1];
    if (Math.hypot(d.x - lastP.x, d.y - lastP.y) * state.zoom > 3) {
      interaction.polyDrag.pts.push(d);
      interaction.polyDrag.moved = true;
    }
    interaction.polyHover = d;
  } else if (state.tool === "polygon" && interaction.polyPoints.length > 0) {
    interaction.polyHover = d;
  }
  render();
}

function onPointerUp(): void {
  interaction.panning = null;
  stage.classList.remove("is-panning");

  // 図形 / 矩形選択の確定
  if (interaction.preview && interaction.dragStart) {
    const p = { ...interaction.preview };
    interaction.preview = null;
    if (p.tool === "select-rect") {
      const x = Math.min(p.x0, p.x1);
      const y = Math.min(p.y0, p.y1);
      const w = Math.abs(p.x1 - p.x0);
      const h = Math.abs(p.y1 - p.y0);
      if (w > 2 && h > 2) selection.applySelection((g) => g.fillRect(x, y, w, h));
    } else {
      history.pushUndo();
      markDirty();
      const px0 = Math.min(p.x0, p.x1);
      const py0 = Math.min(p.y0, p.y1);
      const px1 = Math.max(p.x0, p.x1);
      const py1 = Math.max(p.y0, p.y1);
      const lwPad = state.brushSize / 2 + 2;
      doc.editTargets().forEach((l) => {
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
  if (interaction.lassoPath) {
    const pts = interaction.lassoPath;
    interaction.lassoPath = null;
    if (pts.length > 2) {
      selection.applySelection((g) => {
        g.beginPath();
        g.moveTo(pts[0].x, pts[0].y);
        for (const p of pts) g.lineTo(p.x, p.y);
        g.closePath();
        g.fill();
      });
    }
  }

  // 選択ペンのストローク確定 → Marching ants を更新
  if (interaction.maskStroke) {
    interaction.maskStroke = null;
    selection.commitMaskStroke();
  }

  // 多角形: クリック=頂点追加 / ドラッグ=フリーハンド連結
  if (interaction.polyDrag) {
    const drag = interaction.polyDrag;
    interaction.polyDrag = null;
    if (!drag.moved) {
      // クリック: 始点近傍なら閉じる、そうでなければ頂点を追加
      const d = drag.pts[0];
      const nearStart = interaction.polyPoints.length > 2 && Math.hypot(d.x - interaction.polyPoints[0].x, d.y - interaction.polyPoints[0].y) * state.zoom < 10;
      if (nearStart) closePolygon();
      else interaction.polyPoints.push(d);
    } else {
      for (const p of drag.pts) {
        const lp = interaction.polyPoints[interaction.polyPoints.length - 1];
        if (!lp || Math.hypot(p.x - lp.x, p.y - lp.y) * state.zoom > 1.5) interaction.polyPoints.push(p);
      }
    }
    interaction.polyHover = null;
  }

  stopBloatHold();
  interaction.strokeLast = null;
  interaction.retouchLast = null;
  interaction.filterPenLast = null;
  filterPenBase.clear();
  interaction.dragStart = null;
  render();
}

function closePolygon(): void {
  const pts = interaction.polyPoints;
  interaction.polyPoints = [];
  interaction.polyDrag = null;
  interaction.polyHover = null;
  if (pts.length >= 3) {
    selection.applySelection((g) => {
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
  if (interaction.polyPoints.length > 0 || interaction.polyDrag) {
    interaction.polyPoints = [];
    interaction.polyDrag = null;
    interaction.polyHover = null;
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

function onKeyDown(e: KeyboardEvent): void {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.key === "Alt") interaction.altKey = true;
  const k = e.key.toLowerCase();

  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); if (e.shiftKey) history.redo(); else history.undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); history.redo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "a") { e.preventDefault(); selectAll(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "d") { e.preventDefault(); deselect(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); openExport(); return; }
  if (e.altKey && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); fillSelection(); return; }

  if (e.key === " ") { e.preventDefault(); state.spacePan = true; stage.style.cursor = "grab"; return; }
  if (e.key === "Escape") {
    if (!($("#modal-export") as HTMLElement).hidden) { closeExport(); return; }
    if (interaction.polyDrag || interaction.polyPoints.length > 0) { cancelPolygon(); return; }
    if (interaction.lassoPath) { interaction.lassoPath = null; render(); toast("投げ縄選択を取消", "info"); return; }
    if (interaction.preview || interaction.dragStart) { interaction.preview = null; interaction.dragStart = null; render(); return; }
    // 選択範囲をクリア
    if (selection.hasSelection) deselect();
    return;
  }
  if (e.key === "Enter" && state.tool === "polygon") { closePolygon(); return; }
  if (e.key === "Delete" && selection.hasSelection) {
    deleteSelectionContents();
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
  if (e.key === "Alt") interaction.altKey = false;
  if (e.key === " ") {
    state.spacePan = false;
    stage.style.cursor = TOOLS[state.tool].cursor;
  }
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

  // キャンバスイベント
  view.addEventListener(
    "pointerdown",
    (e) => {
      interaction.dragMods = e.shiftKey ? "add" : e.altKey ? "sub" : null;
      onPointerDown(e);
    },
  );
  view.addEventListener("pointermove", onPointerMove);
  view.addEventListener("pointerup", onPointerUp);
  view.addEventListener("pointercancel", onPointerUp);
  view.addEventListener("pointerleave", () => {
    interaction.cursorPos = null;
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
