/**
 * core/documentStore.ts — レイヤー (ドキュメント) の状態と操作
 * レイヤー配列・アクティブレイヤー・編集対象・ドキュメント実寸・名前の管理と、
 * 合成画像の生成を担う。
 * レイヤーモデル (v0.2.1): 「元画像 (image)」も通常レイヤーと同様に編集・削除可能。
 * 起動 / 画像読み込み時は image レイヤー 1 枚のみで開始する (描画レイヤーはユーザーが追加)。
 * Inpainting マスクは paint レイヤー (+選択範囲) からのみ生成する。
 */
import { clone } from "./canvasUtils";
import { hooks } from "./hooks";
import { DOC_H, DOC_W, type Layer } from "./types";

/** 初期状態のスナップショット (キャンセルで「元の状態」へ戻すため) */
interface LayerSeed {
  name: string;
  kind: Layer["kind"];
  canvas: HTMLCanvasElement;
  visible: boolean;
  locked: boolean;
}

export class DocumentStore {
  layers: Layer[] = [];
  private nextLayerId = 1;
  activeLayerId = 1;
  /** 編集対象レイヤー (描画 / レタッチ系ツールが作用する対象)。常に activeLayerId を含む */
  editTargetIds = new Set<number>();
  /**
   * Inpainting マスクに指定されたレイヤー ID (最大 1 枚 / null = 未指定)。
   * 指定時はエクスポートのマスクをこのレイヤーのみから生成する (ui/exportModal.ts)。
   * 親アプリ (Forge 拡張) からのマスク受信時にもこの指定が使われる (ui/hostBridge.ts)。
   */
  inpaintMaskLayerId: number | null = null;

  /** ドキュメントの実寸 (可変 — 画像読み込み時に変わる) */
  width = DOC_W;
  height = DOC_H;
  /** ドキュメント名 (ヘッダー表示と保存ファイル名の基底) */
  name = "sample_photo.png";

  /** ドキュメント読み込み直後の状態 (キャンセル処理で復元する) */
  private initialSeeds: LayerSeed[] | null = null;

  /** アクティブレイヤーを取得 (存在しない場合は最後のレイヤー) */
  activeLayer(): Layer {
    return this.layers.find((l) => l.id === this.activeLayerId) ?? this.layers[this.layers.length - 1];
  }

  /** 描画 (マスク生成対象) レイヤー一覧 */
  paintLayers(): Layer[] {
    return this.layers.filter((l) => l.kind === "paint");
  }

  /** Inpainting マスクに指定されているレイヤー (未指定 / 削除済みの場合は null) */
  get inpaintMaskLayer(): Layer | null {
    return this.layers.find((l) => l.id === this.inpaintMaskLayerId) ?? null;
  }

  /** レイヤーが Inpainting マスクに指定されているか */
  isInpaintMaskLayer(layer: Layer): boolean {
    return this.inpaintMaskLayerId === layer.id;
  }

  /**
   * レイヤーを Inpainting マスクに指定する (同時に 1 枚のみ / null で解除)。
   * 指定時はエクスポートのマスクをこのレイヤーのみから生成する。
   */
  setInpaintMaskLayer(layer: Layer | null): void {
    const next = layer && this.layers.includes(layer) ? layer.id : null;
    if (this.inpaintMaskLayerId === next) return;
    this.inpaintMaskLayerId = next;
    hooks.renderLayers();
    // マスク指定はキャンバス表示 (ドット網掛) に影響するため即時再描画する
    hooks.render();
    const l = this.layers.find((x) => x.id === next);
    hooks.toast(l ? `「${l.name}」を Inpainting マスクに指定しました` : "Inpainting マスクの指定を解除しました", "ok");
  }

  /**
   * 編集対象レイヤー一覧 (activeLayer を必ず含む。layers の並び順)。
   * ロック中のレイヤーは除外される。
   */
  editTargets(): Layer[] {
    const ids = new Set(this.editTargetIds);
    ids.add(this.activeLayerId);
    return this.layers.filter((l) => ids.has(l.id) && !l.locked);
  }

  makeLayer(name: string, kind: Layer["kind"], image?: HTMLCanvasElement): Layer {
    const canvas = document.createElement("canvas");
    canvas.width = this.width;
    canvas.height = this.height;
    // レタッチ系ツール (覆い焼き/焼き込み) は getImageData を頻用するため CPU 側バッファを優先
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    if (image) ctx.drawImage(image, 0, 0);
    return { id: this.nextLayerId++, name, kind, canvas, ctx, visible: true, locked: false };
  }

  /**
   * ベース画像 (デモ or 読み込み画像) でドキュメントを初期化する。
   * レイヤーは image レイヤー 1 枚のみ (直接編集可能)。初期状態のスナップショットを保持する。
   */
  init(baseImage: HTMLCanvasElement, name = "sample_photo.png"): void {
    this.width = baseImage.width;
    this.height = baseImage.height;
    this.name = name;
    const base = this.makeLayer("元画像", "image", baseImage);
    this.layers = [base];
    this.activeLayerId = base.id;
    this.editTargetIds = new Set([base.id]);
    // ドキュメント差し替え時はマスク指定もリセット (レイヤーが作り直されるため)
    this.inpaintMaskLayerId = null;
    this.saveInitialState();
  }

  /**
   * 画像でドキュメントを読み直す (「開く」/ Ctrl+Shift+V / ドロップ)。
   * 選択・履歴・フィルターのリセットは documentOps 側で行う。
   */
  loadAsDocument(baseImage: HTMLCanvasElement, name?: string): void {
    this.init(baseImage, name ?? this.name);
  }

  /** 初期状態 (読み込み直後) を保存する (キャンセル処理の復元用) */
  private saveInitialState(): void {
    this.initialSeeds = this.layers.map((l) => ({
      name: l.name,
      kind: l.kind,
      canvas: clone(l.canvas),
      visible: l.visible,
      locked: l.locked,
    }));
  }

  /** 初期状態 (読み込み直後) のレイヤー構成へ復元する (キャンセル処理) */
  resetToInitial(): void {
    if (!this.initialSeeds) return;
    this.layers = this.initialSeeds.map((seed) => {
      const l = this.makeLayer(seed.name, seed.kind);
      l.ctx.drawImage(seed.canvas, 0, 0);
      l.visible = seed.visible;
      l.locked = seed.locked;
      return l;
    });
    this.activeLayerId = this.layers[0].id;
    this.editTargetIds = new Set([this.activeLayerId]);
    // レイヤー ID が振り直されるためマスク指定は解除になる
    this.inpaintMaskLayerId = null;
  }

  /** 全ペイントレイヤーをクリア (キャンセル処理) */
  clearPaintLayers(): void {
    for (const l of this.paintLayers()) l.ctx.clearRect(0, 0, this.width, this.height);
  }

  /** 全レイヤー (可視のみ) を合成する。
   *  Inpainting マスクに指定したレイヤーは出力画像に含めない
   *  (エクスポート時は maskImage として別送出されるため、画像に焼き込まない)。 */
  compositeCanvas(): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = this.width;
    c.height = this.height;
    const g = c.getContext("2d")!;
    for (const l of this.layers) {
      if (!l.visible) continue;
      if (l.id === this.inpaintMaskLayerId) continue;
      g.drawImage(l.canvas, 0, 0);
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

  /** 新規レイヤーを追加し、アクティブ + 編集対象にする (copy 指定時は内容を複製)。追加したレイヤーを返す */
  addLayer(copy?: Layer): Layer {
    const l = copy
      ? this.makeLayer(`${copy.name} copy`, copy.kind)
      : this.makeLayer(`Layer ${this.nextPaintLayerNumber()}`, "paint");
    if (copy) l.ctx.drawImage(copy.canvas, 0, 0);
    this.layers.push(l);
    this.activeLayerId = l.id;
    this.editTargetIds = new Set([l.id]);
    hooks.renderLayers();
    hooks.toast(`レイヤー「${l.name}」を追加`, "ok");
    return l;
  }

  /**
   * ワープ結果を target レイヤーの真上へ新規レイヤーとして挿入する
   * (パペット / メッシュワープの「新規レイヤーとして反映」用。元レイヤーは無変更)。
   * レイヤー構造はドキュメント履歴 (Undo) の対象外 — 戻すにはこのレイヤーを削除する。
   */
  insertWarpResultLayer(target: Layer, image: HTMLCanvasElement, name: string): Layer {
    const l = this.makeLayer(name, "paint");
    l.ctx.drawImage(image, 0, 0);
    // 描画順 (下 → 上) の配列なので target の直後に挿入 =「真上」になる
    const idx = this.layers.findIndex((x) => x.id === target.id);
    this.layers.splice(idx + 1, 0, l);
    return l;
  }

  /** 新規描画レイヤー名の連番 (既存連番の重複を避けて採番) */
  private nextPaintLayerNumber(): number {
    let n = this.paintLayers().length + 1;
    while (this.layers.some((l) => l.name === `Layer ${n}`)) n++;
    return n;
  }

  /**
   * 画像を新規レイヤーとして追加する (クリップボードからの貼り付けなど)。
   * レイヤーキャンバスはドキュメント実寸。画像は中央に配置される
   * (ドキュメントより大きい画像はドキュメント範囲でクリップされる)。
   * 既定では追加したレイヤーがアクティブ + 編集対象になる (options.active = false で抑制)。
   */
  addImageLayer(image: HTMLCanvasElement, name?: string, options?: { active?: boolean }): Layer {
    const makeActive = options?.active ?? true;
    const l = this.makeLayer(name ?? `Layer ${this.nextPaintLayerNumber()}`, "paint");
    const dx = Math.round((this.width - image.width) / 2);
    const dy = Math.round((this.height - image.height) / 2);
    l.ctx.drawImage(image, dx, dy);
    this.layers.push(l);
    if (makeActive) {
      this.activeLayerId = l.id;
      this.editTargetIds = new Set([l.id]);
    }
    hooks.renderLayers();
    hooks.render();
    return l;
  }

  /** アクティブレイヤーを削除する (レイヤーが1枚だけの場合は削除不可) */
  deleteActiveLayer(): void {
    if (this.layers.length <= 1) {
      hooks.toast("レイヤーは最低1枚必要です", "info");
      return;
    }
    const l = this.activeLayer();
    this.layers = this.layers.filter((x) => x.id !== l.id);
    this.activeLayerId = this.layers[this.layers.length - 1].id;
    this.editTargetIds = new Set([this.activeLayerId]);
    // 削除されたレイヤーが Inpainting マスク指定中なら解除
    if (this.inpaintMaskLayerId === l.id) this.inpaintMaskLayerId = null;
    hooks.renderLayers();
    hooks.render();
    hooks.toast(`レイヤー「${l.name}」を削除`, "ok");
  }

  /** レイヤーのロック状態を切り替える (ロック中は描画・フィルターの対象外) */
  toggleLock(l: Layer): void {
    l.locked = !l.locked;
    if (l.locked && this.editTargetIds.has(l.id)) {
      this.editTargetIds.delete(l.id);
      if (this.activeLayerId === l.id) hooks.toast("ロック中のレイヤーは編集対象になりません", "info");
    }
    hooks.renderLayers();
    hooks.syncToolGuide();
    hooks.toast(`「${l.name}」を${l.locked ? "ロック" : "ロック解除"}しました`, "info");
  }

  /**
   * レイヤーリストのクリック処理。
   * 通常クリック = アクティブ切替 (編集対象をリセット) / Ctrl+クリック = 編集対象へ追加・解除
   */
  selectLayer(l: Layer, additive: boolean): void {
    if (additive) {
      if (l.id === this.activeLayerId) return; // アクティブレイヤーは常に編集対象
      if (l.locked) {
        hooks.toast("ロック中のレイヤーは編集対象にできません", "info");
        return;
      }
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