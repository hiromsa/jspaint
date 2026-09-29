/**
 * puppet/warpSession.ts — パペットワープのセッション管理
 * ツール選択中 (puppet-warp) だけ有効な「変形セッション」を表す。
 * 開始時に編集対象レイヤーのスナップショットを取り、スナップショット上でメッシュ変形を
 * 試行してプレビューを提供する。レイヤーの実ピクセルは確定 (commit) まで変更しない。
 */
import { clone, createCanvas } from "../core/canvasUtils";
import { doc } from "../core/documentStore";
import { state } from "../core/editorState";
import { hooks } from "../core/hooks";
import { history } from "../core/historyStack";
import { selection } from "../core/selectionStore";
import type { Pt, ToolId } from "../core/types";
import { computeDeformedVertices } from "./deformer";
import { buildMesh, inverseDeformPoint, type PuppetMesh, type PuppetPin } from "./mesh";
import { renderWarped } from "./warpPaint";

/** ピンのヒット判定半径 (画面 px。ドキュメント座標へは zoom で割って使う) */
export const PIN_HIT_RADIUS = 10;

class PuppetWarpSession {
  /** セッション進行中か */
  active = false;
  /** 変形対象のメッシュ (セッション中のみ非 null) */
  mesh: PuppetMesh | null = null;
  /** ピンの変形後頂点座標 (vertices と同順・描画 / オーバーレイ用) */
  deformed: Pt[] = [];
  /** ドラッグ中 / ホバー中のピン ID */
  dragPinId: number | null = null;
  hoverPinId: number | null = null;

  private readonly sources = new Map<number, HTMLCanvasElement>();
  private readonly previews = new Map<number, HTMLCanvasElement>();
  private nextPinId = 1;

  /* ---------- セッションのライフサイクル ---------- */

  /** セッションを開始する (メッシュ生成に失敗した場合は何もせず通常ツールのまま) */
  start(): void {
    if (this.active) return;
    const mesh = this.createMesh();
    if (!mesh) {
      hooks.toast("パペットワープ: 変形できるピクセルがありません", "info");
      return;
    }
    this.resetTo(mesh);
    this.active = true;
    hooks.toast("ピンを打ってドラッグで変形 · Enter=確定 / Esc=取消", "info");
    hooks.syncToolGuide();
  }

  /** メッシュ間隔の変更などでメッシュを作り直す (ピンと変形はリセット) */
  rebuildMesh(): void {
    if (!this.active) return;
    const mesh = this.createMesh();
    if (!mesh) {
      this.cancel();
      return;
    }
    this.resetTo(mesh);
    hooks.toast("メッシュを再生成しました (ピンをリセット)", "info");
    hooks.render();
  }

  /** 変形を確定してレイヤーに焼き込む (Undo スナップショットを積む) */
  commit(): void {
    if (!this.active) return;
    if (this.hasDeformation()) {
      const targets = doc.editTargets().filter((l) => this.sources.has(l.id));
      if (targets.length > 0) {
        history.pushUndo(targets);
        for (const l of targets) {
          const preview = this.previews.get(l.id)!;
          l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
          l.ctx.drawImage(preview, 0, 0);
        }
        hooks.markDirty();
        hooks.toast("パペットワープを確定", "ok");
      }
    }
    this.dispose();
  }

  /** 変形を破棄して元の状態に戻す */
  cancel(): void {
    if (!this.active) return;
    this.dispose();
    hooks.toast("パペットワープを取消", "info");
  }

  /** ツール切替時の引継ぎ (puppet-warp に切り替えたら開始、離れたら自動確定) */
  handleToolChange(tool: ToolId): void {
    if (tool === "puppet-warp") this.start();
    else if (this.active) this.commit();
  }

  /* ---------- ピン操作 ---------- */

  /** 位置 pos (ドキュメント座標) に最も近いピンを探す。radius はドキュメント px */
  pickPin(pos: Pt, radius: number): PuppetPin | null {
    let best: PuppetPin | null = null;
    let bestD = radius * radius;
    for (const pin of this.mesh?.pins ?? []) {
      const dx = pin.current.x - pos.x;
      const dy = pin.current.y - pos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD) {
        best = pin;
        bestD = d2;
      }
    }
    return best;
  }

  /** ピンを追加する (fixed = 固定ピン)。移動ピンはそのままドラッグ対象になる */
  addPin(pos: Pt, fixed: boolean): PuppetPin {
    // 変形済みでも「見た目の位置」に打てるよう、original は初期空間へ逆変換する。
    // original と current は既存変形で対応するペアになるため、ピン追加だけでは画像が動かない
    const origin = this.mesh
      ? inverseDeformPoint(this.mesh, this.deformed, pos)
      : { x: pos.x, y: pos.y };
    const pin: PuppetPin = {
      id: this.nextPinId++,
      original: origin,
      current: { x: pos.x, y: pos.y },
      isPinned: fixed,
    };
    this.mesh?.pins.push(pin);
    if (!fixed) this.dragPinId = pin.id;
    this.refresh();
    hooks.render();
    return pin;
  }

  /** ピンを削除する */
  deletePin(id: number): void {
    if (!this.mesh) return;
    const before = this.mesh.pins.length;
    this.mesh.pins = this.mesh.pins.filter((p) => p.id !== id);
    if (this.mesh.pins.length === before) return;
    if (this.dragPinId === id) this.dragPinId = null;
    if (this.hoverPinId === id) this.hoverPinId = null;
    this.refresh();
    hooks.render();
  }

  /** ドラッグ中ピンを pos へ移動して変形を更新する (固定ピンは無視) */
  moveDragPin(pos: Pt): void {
    const pin = this.mesh?.pins.find((p) => p.id === this.dragPinId);
    if (!pin || pin.isPinned) return;
    pin.current = { x: pos.x, y: pos.y };
    this.refresh();
    hooks.render();
  }

  /** ピンのドラッグを終了する */
  endDrag(): void {
    this.dragPinId = null;
  }

  /** プレビュー中のレイヤー表示キャンバス (編集対象外 or セッション外は null) */
  displayCanvas(layerId: number): HTMLCanvasElement | null {
    return this.active ? (this.previews.get(layerId) ?? null) : null;
  }

  /* ---------- 内部実装 ---------- */

  /** 現在の編集対象レイヤー + 選択範囲からメッシュを生成する */
  private createMesh(): PuppetMesh | null {
    const targets = doc.editTargets();
    if (targets.length === 0) return null;
    // 編集対象レイヤーの合成上の不透明領域を変形対象にする
    const opaque = createCanvas(doc.width, doc.height);
    const og = opaque.getContext("2d")!;
    for (const l of targets) og.drawImage(l.canvas, 0, 0);
    const od = og.getImageData(0, 0, doc.width, doc.height).data;
    const sd = selection.hasSelection ? selection.ctx.getImageData(0, 0, doc.width, doc.height).data : null;
    const contains = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return false;
      const i = ((y | 0) * doc.width + (x | 0)) * 4;
      return od[i + 3] > 0 && (sd === null || sd[i + 3] > 0);
    };
    return buildMesh(contains, state.puppetSpacing, doc.width, doc.height);
  }

  /** メッシュを差し替えてセッションの状態を初期化する */
  private resetTo(mesh: PuppetMesh): void {
    this.mesh = mesh;
    this.sources.clear();
    this.previews.clear();
    for (const l of doc.editTargets()) this.sources.set(l.id, clone(l.canvas));
    this.dragPinId = null;
    this.hoverPinId = null;
    this.nextPinId = 1;
    this.refresh();
  }


  /** ピンの現在位置から変形を再計算し、全レイヤーのプレビューを更新する */
  private refresh(): void {
    if (!this.mesh) return;
    this.deformed = computeDeformedVertices(this.mesh);
    this.previews.clear();
    const hasSel = selection.hasSelection;
    for (const [layerId, source] of this.sources) {
      const warped = renderWarped(source, this.mesh, this.deformed);
      if (!hasSel) {
        this.previews.set(layerId, warped);
        continue;
      }
      // 選択範囲がある場合: 元画像の選択内を空けて、変形結果の選択内部分を重ねる
      const clipped = createCanvas(source.width, source.height);
      const cg = clipped.getContext("2d")!;
      cg.drawImage(warped, 0, 0);
      cg.globalCompositeOperation = "destination-in";
      cg.drawImage(selection.mask, 0, 0);
      const out = createCanvas(source.width, source.height);
      const g = out.getContext("2d")!;
      g.drawImage(source, 0, 0);
      g.globalCompositeOperation = "destination-out";
      g.drawImage(selection.mask, 0, 0);
      g.globalCompositeOperation = "source-over";
      g.drawImage(clipped, 0, 0);
      this.previews.set(layerId, out);
    }
  }

  /** 1 つでもピンが移動していれば true */
  private hasDeformation(): boolean {
    for (const pin of this.mesh?.pins ?? []) {
      if (pin.current.x !== pin.original.x || pin.current.y !== pin.original.y) return true;
    }
    return false;
  }

  private dispose(): void {
    this.active = false;
    this.mesh = null;
    this.deformed = [];
    this.sources.clear();
    this.previews.clear();
    this.dragPinId = null;
    this.hoverPinId = null;
    hooks.render();
    hooks.syncToolGuide();
  }
}

/** アプリ全体で共有するパペットワープセッション */
export const warpSession = new PuppetWarpSession();
