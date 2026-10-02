/**
 * rendering/warpCompose.ts — パペット / メッシュワープ共通のプレビュー合成と「新規レイヤー」確定
 * 変形結果 (warped) と反映方法 (WarpApplyMode) から「レイヤー表示に差し替えるプレビュー」を
 * 作る。canvas 合成に完結した純粋処理にして両ワープのセッションから共用することで、
 * 反映方法の挙動 (表示・確定) を 1 箇所で統一する。
 */
import { clone } from "../core/canvasUtils";
import { doc } from "../core/documentStore";
import { hooks } from "../core/hooks";
import { selection } from "../core/selectionStore";
import type { Layer, WarpApplyMode } from "../core/types";

/** composeWarpPreview の結果 (プレビューと「変形結果そのもの」のペア) */
export interface WarpComposeResult {
  /** レイヤー表示に差し替えるプレビュー canvas (mode に応じた合成結果) */
  preview: HTMLCanvasElement;
  /** 変形結果そのもの (選択範囲あり = 選択範囲でクリップ済み)。「新規レイヤーとして反映」で使う */
  warpedPart: HTMLCanvasElement;
}

/**
 * 変形結果を反映方法に応じて合成する (パペット / メッシュワープ共通)。
 * - destructive (置換): 選択範囲内を変形結果で置き換える (選択範囲なし = 変形結果そのまま)。
 *   ワープで画像が無くなる部分は透明になる (既存の画像を壊す)
 * - overlay / new-layer (上書き): 元画像の上に変形結果を重ねる。
 *   ワープで画像が無くなる部分に元の画像が残る (既存の画像を壊さない)
 */
export function composeWarpPreview(
  source: HTMLCanvasElement,
  warped: HTMLCanvasElement,
  mode: WarpApplyMode,
): WarpComposeResult {
  const hasSel = selection.hasSelection;
  // 変形結果を選択範囲でクリップ (「新規レイヤーとして反映」の確定でもそのまま使う)
  let warpedPart: HTMLCanvasElement = warped;
  if (hasSel) {
    const clipped = clone(warped);
    const cg = clipped.getContext("2d")!;
    cg.globalCompositeOperation = "destination-in";
    cg.drawImage(selection.mask, 0, 0);
    warpedPart = clipped;
  }
  // 恒等変形 (warped === source) はどのモードで合成しても元画像と同じ → コピーを省く
  if (warped === source) return { preview: source, warpedPart };

  const out = clone(source);
  const g = out.getContext("2d")!;
  if (mode === "destructive" && hasSel) {
    // 置換: 選択範囲内の元画像を消してから変形結果を置く (変形で空いた部分は透明のまま)
    g.globalCompositeOperation = "destination-out";
    g.drawImage(selection.mask, 0, 0);
    g.globalCompositeOperation = "source-over";
  }
  // 上書き / 新規レイヤー: 元画像の上に変形結果を重ねる (変形で空いた部分には元画像が残る)
  g.drawImage(warpedPart, 0, 0);
  return { preview: out, warpedPart };
}

/**
 * ワープ結果を「新規レイヤー」として確定する (パペット / メッシュワープ共通)。
 * 編集対象レイヤーごとに、その真上へ変形結果 (選択範囲あり = 選択範囲でクリップ済み) の
 * レイヤーを挿入し、結果レイヤーをアクティブ + 編集対象にする。元レイヤーは一切変更しない。
 * レイヤー構造はドキュメント履歴 (Undo) の対象外のため Undo は積まない
 * (戻すには結果レイヤーを削除する)。確定済みの表示に合わせて再描画する。
 */
export function commitWarpToNewLayers(
  results: Array<{ target: Layer; warpedPart: HTMLCanvasElement }>,
  layerName: string,
): void {
  if (results.length === 0) return;
  // 下のレイヤーから順に「target の真上」へ 1 枚ずつ挿入して順序を保つ
  const created: Layer[] = [];
  for (const { target, warpedPart } of results) {
    const name = results.length > 1 ? `${layerName} (${target.name})` : layerName;
    created.push(doc.insertWarpResultLayer(target, warpedPart, name));
  }
  // 最後に挿入した (一番上の) 結果レイヤーをアクティブにし、編集対象を結果レイヤーへ付け替える
  doc.activeLayerId = created[created.length - 1].id;
  doc.editTargetIds = new Set(created.map((l) => l.id));
  hooks.markDirty();
  hooks.renderLayers();
  hooks.syncToolGuide();
}
