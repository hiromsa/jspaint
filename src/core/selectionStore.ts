/**
 * core/selectionStore.ts — 選択範囲の状態管理
 * 白黒マスクcanvas・選択の有無・Marching Ants (蟲這い破線) の生成とアニメーションを担う。
 */
import { hooks } from "./hooks";
import { interaction } from "./interactionState";
import { state } from "./editorState";
import { createCanvas } from "./canvasUtils";
import { DOC_H, DOC_W, type SelMode } from "./types";

export class SelectionStore {
  /** 選択範囲の白黒マスク (白 = 選択中)。描画系ツールの切り抜き等にも使う */
  readonly mask = createCanvas();
  readonly ctx: CanvasRenderingContext2D;
  hasSelection = false;

  /* Marching Ants (境界エッジの二値描画を4相で巡回) */
  antsBlack: HTMLCanvasElement | null = null;
  readonly antsWhite: HTMLCanvasElement[] = [];
  antPhase = 0;

  /** 選択ペンのストローク中モード (beginMaskStroke → paintMaskSegment → commitMaskStroke) */
  private maskStrokeMode: SelMode | null = null;

  constructor() {
    this.ctx = this.mask.getContext("2d")!;
  }

  /** 選択形状をマスクへ合成 (新規 / 追加 / 除外 — Shift/Alt 修飾優先) */
  applySelection(shape: (g: CanvasRenderingContext2D) => void, modeOverride?: SelMode): void {
    const mode = modeOverride ?? interaction.dragMods ?? state.selMode;
    if (mode === "new") this.ctx.clearRect(0, 0, DOC_W, DOC_H);
    this.ctx.globalCompositeOperation = mode === "sub" ? "destination-out" : "source-over";
    this.ctx.fillStyle = "#fff";
    shape(this.ctx);
    this.ctx.globalCompositeOperation = "source-over";
    this.hasSelection = this.selHasContent();
    this.rebuildAnts();
    hooks.syncToolGuide();
    hooks.markDirty();
  }

  selHasContent(): boolean {
    const d = this.ctx.getImageData(0, 0, DOC_W, DOC_H).data;
    for (let i = 3; i < d.length; i += 16) if (d[i] > 0) return true;
    return false;
  }

  clearSelection(): void {
    this.ctx.clearRect(0, 0, DOC_W, DOC_H);
    this.hasSelection = false;
    this.rebuildAnts();
    hooks.syncToolGuide();
  }

  /** 選択ペン: ストローク開始 (新規モードならマスクをクリア) */
  beginMaskStroke(mode: SelMode): void {
    this.maskStrokeMode = mode;
    if (mode === "new") this.ctx.clearRect(0, 0, DOC_W, DOC_H);
  }

  /** 選択ペン: セグメントをマスクへ描画 */
  paintMaskSegment(from: { x: number; y: number }, to: { x: number; y: number }): void {
    const mode = this.maskStrokeMode;
    if (!mode) return;
    this.ctx.save();
    this.ctx.globalCompositeOperation = mode === "sub" ? "destination-out" : "source-over";
    this.ctx.strokeStyle = "#fff";
    this.ctx.lineWidth = state.brushSize;
    this.ctx.lineCap = "round";
    this.ctx.lineJoin = "round";
    this.ctx.beginPath();
    this.ctx.moveTo(from.x, from.y);
    this.ctx.lineTo(to.x, to.y);
    this.ctx.stroke();
    this.ctx.restore();
  }

  /** 選択ペン: ストローク確定 → Marching ants を更新 */
  commitMaskStroke(): void {
    this.maskStrokeMode = null;
    this.hasSelection = this.selHasContent();
    this.rebuildAnts();
    hooks.syncToolGuide();
  }

  /** 白黒マスクから境界ピクセルを抽出し、4相パターンの ants レイヤーを再構築する */
  rebuildAnts(): void {
    this.antsBlack = createCanvas();
    this.antsWhite.length = 0;
    for (let i = 0; i < 4; i++) this.antsWhite.push(createCanvas());
    if (!this.hasSelection) return;

    const img = this.ctx.getImageData(0, 0, DOC_W, DOC_H);
    const d = img.data;
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= DOC_W || y >= DOC_H ? 0 : d[(y * DOC_W + x) * 4 + 3]);

    const bCtx = this.antsBlack.getContext("2d")!;
    bCtx.fillStyle = "#000";
    const wCtx = this.antsWhite.map((c) => c.getContext("2d")!);
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

  /** ants アニメーション (120ms 毎に相を進めて再描画) */
  startAntLoop(): void {
    let last = 0;
    const tick = (t: number): void => {
      if (t - last > 120) {
        last = t;
        if (this.hasSelection) {
          this.antPhase = (this.antPhase + 1) % 4;
          hooks.render();
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

/** アプリ全体で共有する選択ストア */
export const selection = new SelectionStore();