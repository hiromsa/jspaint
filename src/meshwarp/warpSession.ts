/**
 * meshwarp/warpSession.ts — メッシュワープのセッション管理
 * ツール選択中 (mesh-warp) だけ有効な「変形セッション」を表す。
 * 開始時に編集対象レイヤーのスナップショットを取り、対象領域を囲む 4 ノードの
 * 矩形グリッドを生成する。変形はスナップショット上で試行してプレビューを提供し、
 * レイヤーの実ピクセルは確定 (commit) まで変更しない (パペットワープと同一ルール)。
 */
import { clone, regionBounds } from "../core/canvasUtils";
import { doc } from "../core/documentStore";
import { state } from "../core/editorState";
import { hooks } from "../core/hooks";
import { history } from "../core/historyStack";
import { selection } from "../core/selectionStore";
import type { Pt, ToolId } from "../core/types";
import { composeWarpPreview, commitWarpToNewLayers } from "../rendering/warpCompose";
import { MeshWarpGrid, subPt, type MwEdgeDrag, type MwEdgeHit } from "./meshGrid";
import { renderWarpedMesh } from "./warpPaint";

/** ヒット判定半径 (画面 px。ドキュメント座標へは zoom で割って使う) */
export const MW_NODE_HIT_RADIUS = 8;
export const MW_HANDLE_HIT_RADIUS = 8;
export const MW_EDGE_HIT_RADIUS = 7;

/** パッチ数の上限 (細分化しすぎて転写が重くなるのを防ぐ) */
export const MW_MAX_PATCHES = 256;

/** セッション内 Undo の最大ステップ数 (ドキュメント履歴と同じ) */
export const MW_MAX_HISTORY = 40;

/** ドラッグ中の操作種別 */
type MwDrag =
  | { kind: "node"; nodeId: number; last: Pt; moved: boolean }
  | { kind: "handle"; nodeId: number; neighborId: number; base: Pt; start: Pt; moved: boolean }
  | { kind: "edge"; drag: MwEdgeDrag; moved: boolean };

/** オーバーレイ表示用のハンドル情報 */
export interface MwHandleView {
  nodeId: number;
  neighborId: number;
  point: Pt;
  /** 未編集 (長さ 0) の仮想表示か */
  virtual: boolean;
  /** 選択ノードに直接接続する対向ノード側のハンドルか */
  opposite: boolean;
}

class MeshWarpSession {
  /** セッション進行中か */
  active = false;
  /** 変形対象のグリッド (セッション中のみ非 null) */
  grid: MeshWarpGrid | null = null;
  /** 選択中のノード (ハンドル表示の基準) */
  selectedNodeId: number | null = null;
  /** 進行中のドラッグ */
  drag: MwDrag | null = null;
  /** ホバー中のエッジ (強調表示) */
  hoverEdge: MwEdgeHit | null = null;

  private readonly sources = new Map<number, HTMLCanvasElement>();
  private readonly previews = new Map<number, HTMLCanvasElement>();
  /** 変形結果そのもの (選択範囲あり = クリップ済み)。「新規レイヤーとして反映」の確定に使う */
  private readonly warpParts = new Map<number, HTMLCanvasElement>();
  /** 予約中のドラッグ用プレビュー更新 (rAF ハンドル。0 = なし) */
  private previewRaf = 0;
  /** プレビューが低品質 (ドラッグ中の高速転写) のままか */
  private lowQualityPreview = false;
  /** セッション内 Undo スタック (操作前のグリッドスナップショット。底 = ツール開始時の状態) */
  private readonly undoStack: MeshWarpGrid[] = [];
  /** セッション内 Redo スタック */
  private readonly redoStack: MeshWarpGrid[] = [];

  /* ---------- セッションのライフサイクル ---------- */

  /** セッションを開始する (対象領域が空なら何もせず通常ツールのまま) */
  start(): void {
    if (this.active) return;
    const bounds = this.targetBounds();
    if (!bounds) {
      hooks.toast("メッシュワープ: 変形できるピクセルがありません", "info");
      return;
    }
    // 対象領域 (不透明 × 選択範囲) を囲む矩形グリッドで初期化 (仕様 3.1)
    this.grid = MeshWarpGrid.createRect(bounds.x0, bounds.y0, bounds.x1 + 1, bounds.y1 + 1);
    this.sources.clear();
    this.previews.clear();
    this.warpParts.clear();
    for (const l of doc.editTargets()) this.sources.set(l.id, clone(l.canvas));
    this.selectedNodeId = null;
    this.drag = null;
    this.hoverEdge = null;
    this.lowQualityPreview = false;
    // セッション内履歴: ツール開始時の状態を底に置く (Ctrl+Z でここまで戻せる)
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.undoStack.push(this.grid.clone());
    hooks.updateUndoButtons();
    this.active = true;
    hooks.toast("ノード / ハンドル / 辺をドラッグで変形 · ダブルクリックで細分化 · Enter=確定 / Esc=取消", "info");
    hooks.syncToolGuide();
  }

  /** 変形を確定してレイヤーに焼き込む (置換 / 上書きは Undo スナップショットを積む) */
  commit(): void {
    if (!this.active) return;
    if (this.grid && !this.grid.isIdentity()) {
      // 低品質プレビューが残っていれば高品質で仕上げてから焼き込む
      if (this.lowQualityPreview) this.refresh("high");
      const targets = doc.editTargets().filter((l) => this.sources.has(l.id));
      if (targets.length > 0) {
        if (state.warpApplyMode === "new-layer") {
          // 新規レイヤー: 元レイヤーは無変更。レイヤー追加はドキュメント履歴の対象外 (削除で戻す)
          commitWarpToNewLayers(
            targets.map((l) => ({ target: l, warpedPart: this.warpParts.get(l.id)! })),
            "メッシュワープ",
          );
          hooks.toast("メッシュワープを新規レイヤーに確定 (元のレイヤーは変更していません)", "ok");
        } else {
          history.pushUndo(targets);
          for (const l of targets) {
            const preview = this.previews.get(l.id)!;
            l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
            l.ctx.drawImage(preview, 0, 0);
          }
          hooks.markDirty();
          hooks.toast("メッシュワープを確定", "ok");
        }
      }
    }
    this.dispose();
  }

  /** 変形を破棄して元の状態に戻す */
  cancel(): void {
    if (!this.active) return;
    this.dispose();
    hooks.toast("メッシュワープを取消", "info");
  }

  /** ツール切替時の引継ぎ (mesh-warp に切り替えたら開始、離れたら自動確定) */
  handleToolChange(tool: ToolId): void {
    if (tool === "mesh-warp") this.start();
    else if (this.active) this.commit();
  }

  /* ---------- ドラッグ操作 (仕様 3.4) ---------- */

  /** 位置 d (ドキュメント座標) でドラッグを開始する (ハンドル → ノード → エッジの優先順) */
  beginDrag(d: Pt, zoom: number): void {
    const grid = this.grid;
    if (!grid) return;
    // 1. ハンドル (選択ノード + 対向ノードのハンドルのみ。仕様 3.2)
    if (this.selectedNodeId != null) {
      const hit = this.pickHandle(d, MW_HANDLE_HIT_RADIUS / zoom);
      if (hit) {
        const base = grid.node(hit.nodeId).posHandles.get(hit.neighborId)
          ?? subPt(grid.handleTarget(hit.nodeId, hit.neighborId).point, grid.node(hit.nodeId).pos);
        this.drag = { kind: "handle", nodeId: hit.nodeId, neighborId: hit.neighborId, base, start: d, moved: false };
        return;
      }
    }
    // 2. ノード (クリックで選択。ドラッグで移動)
    const node = grid.hitNode(d, MW_NODE_HIT_RADIUS / zoom);
    if (node) {
      this.selectedNodeId = node.id;
      this.drag = { kind: "node", nodeId: node.id, last: d, moved: false };
      hooks.render();
      return;
    }
    // 3. エッジ (辺の直接ドラッグ)
    const edge = grid.hitEdge(d, MW_EDGE_HIT_RADIUS / zoom);
    if (edge) {
      this.drag = { kind: "edge", drag: grid.beginEdgeDrag(edge, d), moved: false };
    }
  }

  /** ドラッグ中のポインタ移動を適用する */
  moveDrag(d: Pt): void {
    const grid = this.grid;
    const drag = this.drag;
    if (!grid || !drag) return;
    if (!drag.moved) {
      // 最初の移動で「操作前の状態」をセッション内履歴へ積む (Ctrl+Z で 1 操作ずつ戻せる)
      this.pushUndo();
      drag.moved = true;
    }
    if (drag.kind === "node") {
      grid.moveNode(drag.nodeId, subPt(d, drag.last));
      drag.last = d;
    } else if (drag.kind === "handle") {
      grid.setHandle(drag.nodeId, drag.neighborId, {
        x: drag.base.x + (d.x - drag.start.x),
        y: drag.base.y + (d.y - drag.start.y),
      });
    } else {
      grid.applyEdgeDrag(drag.drag, d);
    }
    this.schedulePreview();
  }

  /** ドラッグを終了し、高品質でプレビューを仕上げ直す */
  endDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    if (this.lowQualityPreview) this.refresh("high");
    hooks.render();
  }

  /** ダブルクリック: エッジ上ならライン追加 / パッチ内なら縦横ライン追加 (グリッド全体に貫通、仕様 3.3) */
  handleDoubleTap(d: Pt, zoom: number): void {
    const grid = this.grid;
    if (!grid) return;
    // ノード上のダブルクリックは対象外 (誤操作防止)
    if (grid.hitNode(d, MW_NODE_HIT_RADIUS / zoom)) return;
    const edge = grid.hitEdge(d, MW_EDGE_HIT_RADIUS / zoom);
    if (edge) {
      this.pushUndo();
      grid.splitEdgeHit(edge);
      this.selectedNodeId = null;
      this.refresh("high");
      hooks.toast("ラインを追加しました", "info");
      hooks.render();
      return;
    }
    if (grid.patches.length >= MW_MAX_PATCHES) {
      hooks.toast(`パッチ数が上限 (${MW_MAX_PATCHES}) に達しています`, "info");
      return;
    }
    const hit = grid.patchAt(d);
    if (hit) {
      this.pushUndo();
      grid.splitPatchAt(hit.patch, hit.u, hit.v);
      this.selectedNodeId = null;
      this.refresh("high");
      hooks.toast("縦横のラインを追加しました", "info");
      hooks.render();
    }
  }

  /* ---------- セッション内 Undo / Redo (Ctrl+Z / Ctrl+Y / ヘッダーの Undo・Redo ボタン) ---------- */

  /** セッション内で取り消せる操作があるか (ヘッダーの Undo ボタン制御用)。
   *  底 (ツール開始時の状態) 以外のスナップショットがあれば 1 操作以上取り消せる */
  get canUndo(): boolean {
    return this.active && this.undoStack.length > 1;
  }

  /** セッション内でやり直せる操作があるか */
  get canRedo(): boolean {
    return this.active && this.redoStack.length > 0;
  }

  /** 操作前のグリッド状態を履歴へ積む (新しい操作を行うたびに Redo をクリア) */
  pushUndo(): void {
    const grid = this.grid;
    if (!grid) return;
    this.undoStack.push(grid.clone());
    if (this.undoStack.length > MW_MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
    hooks.updateUndoButtons();
  }

  /** セッション内の 1 操作を取り消す (ツール開始時の状態まで戻せる) */
  undo(): void {
    const grid = this.grid;
    if (!grid || this.undoStack.length === 0) return;
    this.redoStack.push(grid.clone());
    this.grid = this.undoStack.pop()!;
    this.selectedNodeId = null;
    this.hoverEdge = null;
    this.refresh("high");
    hooks.updateUndoButtons();
    hooks.render();
  }

  /** 取り消したセッション内の操作をやり直す */
  redo(): void {
    const grid = this.grid;
    if (!grid || this.redoStack.length === 0) return;
    this.undoStack.push(grid.clone());
    this.grid = this.redoStack.pop()!;
    this.selectedNodeId = null;
    this.hoverEdge = null;
    this.refresh("high");
    hooks.updateUndoButtons();
    hooks.render();
  }

  /** レイヤー id に対応する変形プレビュー canvas (セッション中のみ。renderer の表示差し替え用) */
  displayCanvas(layerId: number): HTMLCanvasElement | null {
    return this.active ? this.previews.get(layerId) ?? null : null;
  }

  /** 反映方法 (WarpApplyMode) の変更などをプレビューへ即座に反映する */
  refreshPreview(): void {
    if (!this.active) return;
    this.cancelScheduledPreview();
    this.refresh("high");
    hooks.render();
  }

  /* ---------- ホバー / ハンドル表示 (仕様 3.2) ---------- */

  /**
   * 表示すべきハンドル一覧: 選択ノードから伸びる全ハンドルと、
   * 隣接する直近のノードから伸びる対向ハンドル。
   */
  visibleHandles(): MwHandleView[] {
    const grid = this.grid;
    if (!grid || this.selectedNodeId == null) return [];
    const out: MwHandleView[] = [];
    for (const nb of grid.neighborIdsOf(this.selectedNodeId)) {
      const own = grid.handleTarget(this.selectedNodeId, nb);
      out.push({ nodeId: this.selectedNodeId, neighborId: nb, point: own.point, virtual: own.virtual, opposite: false });
      const opp = grid.handleTarget(nb, this.selectedNodeId);
      out.push({ nodeId: nb, neighborId: this.selectedNodeId, point: opp.point, virtual: opp.virtual, opposite: true });
    }
    return out;
  }

  /** 位置 d に最も近い表示中ハンドル (radius はドキュメント px) */
  pickHandle(d: Pt, radius: number): { nodeId: number; neighborId: number } | null {
    let best: { nodeId: number; neighborId: number } | null = null;
    let bestD = radius * radius;
    for (const h of this.visibleHandles()) {
      const dx = h.point.x - d.x;
      const dy = h.point.y - d.y;
      const dd = dx * dx + dy * dy;
      if (dd <= bestD) {
        bestD = dd;
        best = { nodeId: h.nodeId, neighborId: h.neighborId };
      }
    }
    return best;
  }

  /** ホバー位置に応じたカーソル形状 (ノード=移動 / ハンドル・エッジ=つかむ / それ以外=十字) */
  hoverCursor(d: Pt, zoom: number): string {
    const grid = this.grid;
    if (!grid || this.drag) return "crosshair";
    if (this.selectedNodeId != null && this.pickHandle(d, MW_HANDLE_HIT_RADIUS / zoom)) return "grab";
    if (grid.hitNode(d, MW_NODE_HIT_RADIUS / zoom)) return "move";
    if (grid.hitEdge(d, MW_EDGE_HIT_RADIUS / zoom)) return "grab";
    return "crosshair";
  }

  /** ホバー中エッジの追跡 (オーバーレイ強調用) */
  updateHover(d: Pt, zoom: number): void {
    const grid = this.grid;
    if (!grid || this.drag) {
      this.hoverEdge = null;
      return;
    }
    this.hoverEdge = grid.hitEdge(d, MW_EDGE_HIT_RADIUS / zoom);
  }

  /* ---------- プレビュー (パペットワープと同一の合成ルール) ---------- */

  /** 変形対象 (編集対象レイヤー合成の不透明領域 × 選択範囲) の外接矩形 */
  private targetBounds(): { x0: number; y0: number; x1: number; y1: number } | null {
    const od = doc.compositeCanvas().getContext("2d")!.getImageData(0, 0, doc.width, doc.height).data;
    const sd = selection.hasSelection ? selection.ctx.getImageData(0, 0, doc.width, doc.height).data : null;
    const contains = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return false;
      const i = ((y | 0) * doc.width + (x | 0)) * 4;
      return od[i + 3] > 0 && (sd === null || sd[i + 3] > 0);
    };
    return regionBounds(contains, doc.width, doc.height);
  }

  /** 現在のグリッドから変形を再計算し、全レイヤーのプレビューを更新する */
  private refresh(quality: ImageSmoothingQuality = "high"): void {
    const grid = this.grid;
    if (!grid) return;
    this.lowQualityPreview = quality !== "high";
    this.previews.clear();
    this.warpParts.clear();
    // 恒等変形のうちは重いメッシュ転写を省き元画像をそのまま使う
    const isDeformed = !grid.isIdentity();
    for (const [layerId, source] of this.sources) {
      const warped = isDeformed ? renderWarpedMesh(source, grid, quality) : source;
      // 反映方法 (上書き / 置換 / 新規レイヤー) に応じた合成は両ワープで共用。
      // 選択範囲がある場合はここで「変形結果」の選択内部分が正しくクリップされる
      // (v0.2.25 以前は元画像をクリップしており、ドラッグ中のプレビューが動かなかった)
      const composed = composeWarpPreview(source, warped, state.warpApplyMode);
      this.previews.set(layerId, composed.preview);
      this.warpParts.set(layerId, composed.warpedPart);
    }
  }

  /** ドラッグ中のプレビュー更新を 1 フレームに 1 回へ間引く (pointermove 高頻度対策) */
  private schedulePreview(): void {
    if (this.previewRaf) return;
    this.previewRaf = requestAnimationFrame(() => {
      this.previewRaf = 0;
      // ドラッグが終わっていたら何もしない (endDrag で高品質に仕上げ直す)
      if (!this.active || !this.drag) return;
      // ドラッグ中は低品質補間で転写を軽くする (離した時に高品質で仕上げ直す)
      this.refresh("low");
      hooks.render();
    });
  }

  /** 予約中のプレビュー更新を取り消す */
  private cancelScheduledPreview(): void {
    if (this.previewRaf) {
      cancelAnimationFrame(this.previewRaf);
      this.previewRaf = 0;
    }
  }

  private dispose(): void {
    this.cancelScheduledPreview();
    this.active = false;
    this.grid = null;
    this.sources.clear();
    this.previews.clear();
    this.warpParts.clear();
    this.selectedNodeId = null;
    this.drag = null;
    this.hoverEdge = null;
    // セッション内履歴も破棄する (確定済みの変形はドキュメント履歴の Undo で戻る)
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    hooks.render();
    hooks.updateUndoButtons();
    hooks.syncToolGuide();
  }
}

/** アプリ全体で共有するメッシュワープセッション */
export const meshWarpSession = new MeshWarpSession();
