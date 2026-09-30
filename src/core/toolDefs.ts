/**
 * core/toolDefs.ts — ツールのメタ定義 (ラベル / ショートカット / ガイド / アイコン)
 * 振る舞いは含まない純粋な定数。UI 表示とキーボード対応の両方から参照される。
 */
import type { ToolId } from "./types";

export const TOOLS: Record<ToolId, { label: string; key: string; guide: string; cursor: string }> = {
  brush:       { label: "ブラシ",       key: "B", guide: "ドラッグで描画 · [ ] でサイズ", cursor: "none" },
  eraser:      { label: "消しゴム",     key: "E", guide: "ドラッグで描画を消去", cursor: "none" },
  bucket:      { label: "塗りつぶし",   key: "G", guide: "クリックで類似色領域を塗りつぶし", cursor: "crosshair" },
  smudge:      { label: "指先",         key: "S", guide: "ドラッグで色をにじませる · [ ] でサイズ", cursor: "none" },
  bloat:       { label: "膨張",         key: "V", guide: "ドラッグで領域を球面状に変形 · 長押しで持続 · [ ] でサイズ · Alt で方向を一時反転", cursor: "none" },
  "puppet-warp": { label: "パペットワープ", key: "T", guide: "クリック=ピンを打つ (Alt=固定ピン) · ピンをドラッグ=変形 · ダブルクリック=ピン削除 · Enter=確定 / Esc=取消 · 選択範囲があればその範囲のみ", cursor: "crosshair" },
  dodge:       { label: "覆い焼き",     key: "D", guide: "ドラッグで明るく · Alt で焼き込みに反転", cursor: "none" },
  burn:        { label: "焼き込み",     key: "J", guide: "ドラッグで暗く · Alt で覆い焼きに反転", cursor: "none" },
  "filter-pen": { label: "フィルターペン", key: "F", guide: "ドラッグでなぞった範囲にフィルター効果を焼き込む · ツールタブで内容を設定", cursor: "none" },
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

/** ツール ID → アイコン名 (assets/icons.ts の ICONS キー) */
export const TOOL_ICON: Record<ToolId, string> = {
  brush: "brush", eraser: "eraser", bucket: "bucket",
  smudge: "smudge", bloat: "bloat", "puppet-warp": "pin", dodge: "sun", burn: "moon", "filter-pen": "sparkles",
  line: "line", rect: "square", ellipse: "circle",
  "select-rect": "box-select", lasso: "lasso", polygon: "pentagon", wand: "wand", "mask-pen": "pen",
  eyedropper: "pipette", pan: "hand",
};

/** キーボードショートカット → ツール ID */
export const KEY_TOOL: Record<string, ToolId> = {
  b: "brush", e: "eraser", g: "bucket",
  s: "smudge", v: "bloat", t: "puppet-warp", d: "dodge", j: "burn", f: "filter-pen",
  l: "line", u: "rect", o: "ellipse",
  m: "select-rect", q: "lasso", p: "polygon", w: "wand", k: "mask-pen",
  i: "eyedropper", h: "pan",
};

/** 選択範囲の影響を受ける描画系ツール (選択中はその範囲内のみ描画) */
export const PAINT_TOOLS: ToolId[] = ["brush", "eraser", "bucket", "smudge", "bloat", "dodge", "burn", "filter-pen", "line", "rect", "ellipse"];

/** サイズスライダー (state.brushSize) を持つツール — ツール別サイズの記憶対象。
 *  index.html のサイズ行 (data-show) と同じメンバーを保つこと */
export const SIZE_TOOLS: ToolId[] = ["brush", "eraser", "line", "rect", "ellipse", "mask-pen", "smudge", "bloat", "dodge", "burn", "filter-pen"];

/** 円形ブラシカーソルを表示するツール */
export const CIRCLE_CURSOR_TOOLS: ToolId[] = ["brush", "eraser", "mask-pen", "smudge", "bloat", "dodge", "burn", "filter-pen"];