/**
 * core/interactionState.ts — ポインタ操作中の経過状態
 * interaction/ (入力処理) が書き込み、rendering/ (描画) と painting/ (ツール) が読む。
 * オブジェクト自体は不変 (プロパティのみ更新) なので複数モジュールから共有できる。
 */
import type { Pt, SelMode, StrokePreview } from "./types";

export const interaction = {
  /** ドラッグ中の図形 / 矩形選択プレビュー */
  preview: null as StrokePreview | null,
  /** 投げ縄選択の経路 (ドラッグ中) */
  lassoPath: null as Pt[] | null,
  /** 多角形選択の確定済み頂点 */
  polyPoints: [] as Pt[],
  /** 多角形選択のマウス追従頂点 */
  polyHover: null as Pt | null,
  /** 多角形選択のドラッグ中フリーハンド */
  polyDrag: null as { pts: Pt[]; moved: boolean } | null,
  /** 選択ペンのストローク中状態 */
  maskStroke: null as { mode: SelMode; last: Pt } | null,
  /** カーソルのドキュメント座標 (円形カーソル / 座標表示用) */
  cursorPos: null as Pt | null,
  /** ドラッグ開始時に確定した選択合成モード (Shift=追加 / Alt=除外) */
  dragMods: null as SelMode | null,
  /** ブラシ / 消しゴムのストローク最終位置 */
  strokeLast: null as Pt | null,
  /** パン (表示移動) 中の基準位置 */
  panning: null as { sx: number; sy: number } | null,
  /** 図形 / 矩形選択ドラッグの開始位置 */
  dragStart: null as Pt | null,
  /** レタッチ系ツール (指先 / 膨張 / 覆い焼き / 焼き込み) の最終適用位置 */
  retouchLast: null as Pt | null,
  /** フィルターペンのドラッグ中の最後の座標 */
  filterPenLast: null as Pt | null,
  /** Alt キーの押下状態 (rAF ループ内ではイベントが取れないため追跡) */
  altKey: false,
};