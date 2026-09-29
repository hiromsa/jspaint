/**
 * core/historyStack.ts — Undo / Redo (スナップショット方式)
 * 対象レイヤーのピクセルと選択状態をセットで保存・復元する。
 */
import { clone } from "./canvasUtils";
import { doc, DocumentStore } from "./documentStore";
import { hooks } from "./hooks";
import { selection, SelectionStore } from "./selectionStore";
import type { Layer } from "./types";

/** 1レイヤー分のスナップショット (複数レイヤー編集対象に対応) */
export interface LayerSnap {
  layerId: number;
  layer: HTMLCanvasElement;
}

export interface Snap {
  layers: LayerSnap[];
  sel: HTMLCanvasElement;
  hasSel: boolean;
}

const MAX_HISTORY = 40;

export class HistoryStack {
  private readonly undoStack: Snap[] = [];
  private readonly redoStack: Snap[] = [];

  constructor(
    private readonly documentStore: DocumentStore,
    private readonly selectionStore: SelectionStore,
  ) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Undo 対象レイヤーのスナップショットを積む。未指定時は現在の編集対象レイヤーすべて */
  pushUndo(target?: Layer | Layer[]): void {
    const list = target ? (Array.isArray(target) ? target : [target]) : this.documentStore.editTargets();
    this.undoStack.push({
      layers: list.map((l) => ({ layerId: l.id, layer: clone(l.canvas) })),
      sel: clone(this.selectionStore.mask),
      hasSel: this.selectionStore.hasSelection,
    });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
    hooks.updateUndoButtons();
  }

  /** 編集をリセット (スタック全消去) */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    hooks.updateUndoButtons();
  }

  undo(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push({
      layers: this.snapCurrent(s.layers.map((x) => x.layerId)),
      sel: clone(this.selectionStore.mask),
      hasSel: this.selectionStore.hasSelection,
    });
    this.restoreSnap(s);
  }

  redo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push({
      layers: this.snapCurrent(s.layers.map((x) => x.layerId)),
      sel: clone(this.selectionStore.mask),
      hasSel: this.selectionStore.hasSelection,
    });
    this.restoreSnap(s);
  }

  /** 反対スタックへ積む「現在状態」のスナップショット (pop したスナップショットと同じレイヤー集合) */
  private snapCurrent(layerIds: number[]): LayerSnap[] {
    return layerIds
      .map((id) => this.documentStore.layers.find((l) => l.id === id))
      .filter((l): l is Layer => Boolean(l))
      .map((l) => ({ layerId: l.id, layer: clone(l.canvas) }));
  }

  /** スナップショットをレイヤー / 選択状態へ復元 */
  private restoreSnap(s: Snap): void {
    for (const { layerId, layer } of s.layers) {
      const t = this.documentStore.layers.find((x) => x.id === layerId);
      if (t) {
        t.ctx.clearRect(0, 0, t.canvas.width, t.canvas.height);
        t.ctx.drawImage(layer, 0, 0);
      }
    }
    const sel = this.selectionStore;
    sel.ctx.clearRect(0, 0, sel.mask.width, sel.mask.height);
    if (s.hasSel) sel.ctx.drawImage(s.sel, 0, 0);
    sel.hasSelection = s.hasSel;
    sel.rebuildAnts();
    hooks.syncToolGuide();
    hooks.renderLayers();
    hooks.updateUndoButtons();
  }
}

/** アプリ全体で共有する Undo / Redo スタック */
export const history = new HistoryStack(doc, selection);