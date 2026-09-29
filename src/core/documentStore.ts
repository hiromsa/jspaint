/**
 * core/documentStore.ts — レイヤー (ドキュメント) の状態と操作
 * レイヤー配列・アクティブレイヤー・編集対象の管理と、合成画像の生成を担う。
 * 背景レイヤーの描画処理 (前処理フィルター) は setBasePainter() で差し込む
 * (FilterEngine への依存を避けるため)。
 */
import { hooks } from "./hooks";
import { DOC_H, DOC_W, type Layer } from "./types";

export class DocumentStore {
  layers: Layer[] = [];
  private nextLayerId = 1;
  activeLayerId = 2;
  /** 編集対象レイヤー (描画 / レタッチ系ツールが作用する対象)。常に activeLayerId を含む */
  editTargetIds = new Set<number>();

  /** ドキュメントの実寸 (可変 — 画像読み込み時に変わる) */
  width = DOC_W;
  height = DOC_H;
  /** ドキュメント名 (ヘッダー表示と保存ファイル名の基底) */
  name = "sample_photo.png";

  private basePainter: ((g: CanvasRenderingContext2D) => void) | null = null;

  /** 背景レイヤー (元画像) の描画処理を差し込む */
  setBasePainter(painter: (g: CanvasRenderingContext2D) => void): void {
    this.basePainter = painter;
  }

  baseLayer(): Layer | undefined {
    return this.layers.find((l) => l.kind === "base");
  }

  activeLayer(): Layer {
    return this.layers.find((l) => l.id === this.activeLayerId)!;
  }

  paintLayers(): Layer[] {
    return this.layers.filter((l) => l.kind === "paint");
  }

  /** 編集対象レイヤー一覧 (activeLayer を必ず含む。layers の並び順) */
  editTargets(): Layer[] {
    const ids = new Set(this.editTargetIds);
    ids.add(this.activeLayerId);
    return this.layers.filter((l) => ids.has(l.id));
  }

  makeLayer(name: string, kind: "base" | "paint", image?: HTMLCanvasElement): Layer {
    const canvas = document.createElement("canvas");
    canvas.width = this.width;
    canvas.height = this.height;
    // レタッチ系ツール (覆い焼き/焼き込み) は getImageData を頻用するため CPU 側バッファを優先
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    if (image) ctx.drawImage(image, 0, 0);
    return { id: this.nextLayerId++, name, kind, canvas, ctx, visible: true };
  }

  /** ベース画像 (デモ or 読み込み画像) でドキュメントを初期化する */
  init(baseImage: HTMLCanvasElement, name = "sample_photo.png"): void {
    this.width = baseImage.width;
    this.height = baseImage.height;
    this.name = name;
    this.layers = [this.makeLayer("背景 (元画像)", "base", baseImage)];
    const l1 = this.makeLayer("Layer 1", "paint");
    this.layers.push(l1);
    this.activeLayerId = l1.id;
    this.editTargetIds = new Set([l1.id]);
  }

  /**
   * 背景画像を差し替え、ドキュメントサイズを読み込み画像に合わせる。
   * 既存のペイントレイヤーは空の状態で再作成される (選択・履歴・フィルターの
   * リセットは documentOps.applyBaseImage が一括して行う)。
   */
  replaceBaseImage(baseImage: HTMLCanvasElement, name?: string): void {
    this.init(baseImage, name ?? this.name);
  }

  /** 全ペイントレイヤーをクリア (キャンセル処理) */
  clearPaintLayers(): void {
    for (const l of this.paintLayers()) l.ctx.clearRect(0, 0, this.width, this.height);
  }

  /** 背景レイヤー (前処理フィルター適用) + 可視ペイントレイヤーを合成する */
  compositeCanvas(): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = this.width;
    c.height = this.height;
    const g = c.getContext("2d")!;
    if (this.basePainter) this.basePainter(g);
    for (const l of this.layers) {
      if (l.kind === "paint" && l.visible) g.drawImage(l.canvas, 0, 0);
    }
    return c;
  }

  /** 合成画像から色を取得 */
  pickColor(x: number, y: number): string | null {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    const d = this.compositeCanvas().getContext("2d")!.getImageData(x | 0, y | 0, 1, 1).data;
    const to2 = (n: number) => n.toString(16).padStart(2, "0");
    return `#${to2(d[0])}${to2(d[1])}${to2(d[2])}`;
  }

  /** レイヤーを追加し、アクティブ + 編集対象にする */
  addLayer(copy?: Layer): void {
    const l = copy
      ? this.makeLayer(`${copy.name} copy`, "paint")
      : this.makeLayer(`Layer ${this.paintLayers().length + 1}`, "paint");
    if (copy) l.ctx.drawImage(copy.canvas, 0, 0);
    this.layers.push(l);
    this.activeLayerId = l.id;
    this.editTargetIds = new Set([l.id]);
    hooks.renderLayers();
    hooks.toast(`レイヤー「${l.name}」を追加`, "ok");
  }

  /** アクティブレイヤーを削除する (背景 / 最後のペイントレイヤーは削除不可) */
  deleteActiveLayer(): void {
    const l = this.activeLayer();
    if (l.kind === "base") {
      hooks.toast("背景レイヤーは削除できません", "info");
      return;
    }
    if (this.paintLayers().length <= 1) {
      hooks.toast("ペイントレイヤーは最低1枚必要です", "info");
      return;
    }
    this.layers = this.layers.filter((x) => x.id !== l.id);
    this.activeLayerId = this.paintLayers().at(-1)!.id;
    this.editTargetIds = new Set([this.activeLayerId]);
    hooks.renderLayers();
    hooks.render();
    hooks.toast(`レイヤー「${l.name}」を削除`, "ok");
  }

  /**
   * レイヤーリストのクリック処理。
   * 通常クリック = アクティブ切替 (編集対象をリセット) / Ctrl+クリック = 編集対象へ追加・解除
   */
  selectLayer(l: Layer, additive: boolean): void {
    if (additive) {
      if (l.id === this.activeLayerId) return; // アクティブレイヤーは常に編集対象
      if (this.editTargetIds.has(l.id)) {
        this.editTargetIds.delete(l.id);
        hooks.toast(`「${l.name}」を編集対象から解除`, "info");
      } else {
        this.editTargetIds.add(l.id);
        hooks.toast(`「${l.name}」を編集対象に追加 (${this.editTargets().length} 対象)`, "ok");
      }
    } else if (l.id !== this.activeLayerId || this.editTargetIds.size > 1) {
      const wasMulti = this.editTargets().length > 1;
      this.activeLayerId = l.id;
      this.editTargetIds = new Set([l.id]);
      if (wasMulti) hooks.toast(`編集対象を「${l.name}」のみにリセット`, "info");
    }
    hooks.renderLayers();
    hooks.syncToolGuide();
  }
}

/** アプリ全体で共有するドキュメントストア */
export const doc = new DocumentStore();