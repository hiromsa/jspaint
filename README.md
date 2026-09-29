# JSPaint — Inpainting Pre-processing Paint Tool (UI Mock)

Stable Diffusion Web UI (Forge / A1111) などの **inpainting 前処理**として iframe 埋め込みで使うことを想定した、
TypeScript 製の軽量ペイントツールです。本リポジトリは **UI モック** (実際にブラシ描画・選択・エクスポートが動作するデモ) を提供します。
UI仕様の詳細は [docs/specification/ui.md](docs/specification/ui.md) を参照してください。

## 起動方法

```bash
npm install
npm run dev        # 開発サーバ (http://localhost:5173)
npm run build      # dist/index.html — 単一HTML (依存なし・file:// ダブルクリックで起動可)
npm run typecheck  # tsc --noEmit
```

ビルド成果物は `dist/index.html` の **1ファイルのみ**。`vite-plugin-singlefile` により JS/CSS がすべてインライン化されるため、
単体で動作します (オフライン OK / デモ画像はCanvasで自動生成)。

## 実装内容

| エリア | 内容 |
|---|---|
| Header | Undo/Redo、ズーム (25%〜800%)、フィット、ドキュメント情報、キャンセル/完了 |
| Toolbox | ブラシ・消しゴム・バケツ / 指先・**膨張**・覆い焼き・焼き込み・フィルターペン / 直線・矩形・円 / 矩形・投げ縄・多角形・魔法の杖・選択ペン選択 / スポイト・手のひら + 前景/背景色 |
| Workspace | チェッカーボード + 640×640 ステージ。パン (Space/中ボタン/手のひら)、ズーム (ホイール) |
| Properties | ①ツール設定 (サイズ・不透明度・許容度・選択合成モード) ②前処理フィルター ③レイヤー |
| StatusBar | ツール名、X/Y座標、操作ガイド、バージョン |
| Export Modal | 合成画像 & 白黒マスクのプレビュー、PNG保存、`postMessage({ type: 'JSPAINT_EXPORT', ... })` |

### 動作する主な機能 (モック範囲)

- ブラシ / 消しゴム / 図形 / 塗りつぶし (スキャンライン flood fill・許容度対応)
- 矩形・投げ縄・多角形 (**クリック=頂点追加 / ドラッグ=フリーハンド**)・魔法の杖による選択
- **選択ペン** (`K`): ドラッグで選択マスクを直接描画 (追加/除外モード対応)
- **膨張ブラシ** (`V`): ブラシ中心を基準にピクセルを放射状に押し広げるリキフィ系ツール。**押しっぱなしにしている間、その場で時間ベースに持続適用**され、ドラッグで膨らませる位置を移動できる。「効果の方向」で膨張 / 収縮を切替 (Alt で一時反転)。サイズ = radius、強さ = strength。選択範囲限定・編集対象レイヤー複数適用・Undo対応
- **フィルターペン** (`F`): フィルタータブで有効中のフィルターを、ペンでなぞった範囲に直接焼き込む (サイズ・適用の強さ・選択範囲限定 / 1ストローク内では効果が一定)
- 選択合成モード: 新規 / ＋追加 (Shift) / −除外 (Alt)
- **選択範囲の塗りつぶし** (`Alt+Delete`)・解除 (`Ctrl+D`)・範囲内消去 (`Delete`)
- **前処理フィルター**: ぼかし / **ノイズ (0-100%, シード固定の決定論的グレイン — カラー / グレー切替、既定はカラー)** / 明るさ / コントラスト / 彩度 / 色相
  - 選択範囲がある場合は**その範囲のみ**適用 (プレビュー/エクスポート両方)
  - **確定(ベイク)** で背景レイヤーに焼き込み、フィルター設定をリセット (Undo対応)
- **Marching Ants**: 白黒マスクから境界ピクセルを抽出し、4相パターンでアニメーション
- レイヤー (背景=フィルター適用対象 + ペイントレイヤー)、可視性・複製・削除
- Undo / Redo (Ctrl+Z / Ctrl+Y)
- エクスポート: 背景フィルター+全レイヤーの合成画像、黒背景+白二値のマスク画像

### ショートカット

`B/E/G/S/V/D/J/F/L/U/O/M/Q/P/W/K/I/H` ツール切替 · `X` 色入替 · `[` `]` ブラシサイズ ·
`Ctrl+Z/Y` Undo/Redo · `Ctrl+A` すべて選択 · `Ctrl+D` 選択解除 · `Alt+Delete` 選択範囲を塗りつぶし ·
`Delete` 選択範囲を消去 · `0` 100% · `1` フィット · `Ctrl+Enter` エクスポート

詳細な仕様は [docs/specification/ui.md](docs/specification/ui.md)、進捗は [docs/PROGRESS.md](docs/PROGRESS.md) を参照。

## 親アプリ連携 (仕様)

iframe で埋め込み、「完了 (Export)」→「親アプリへ送信」で次のメッセージを送信します:

```ts
window.parent.postMessage({
  type: "JSPAINT_EXPORT",
  compositeImage: dataURL, // 合成画像 (背景+フィルター+ペイントレイヤー)
  maskImage: dataURL,      // Inpaintingマスク (黒=維持 / 白=再生成)
}, "*");
```

単体 (file:// 直開き) の場合は iframe 未検出を検出し、PNG ダウンロードへ誘導します。

## 構成

```
index.html          … UI骨格
src/main.ts         … エントリ
src/app.ts          … 状態・描画エンジン・UI配線
src/icons.ts        … lucide アイコン (インラインSVG)
src/demo.ts         … 単体動作用デモ画像 (Canvas生成)
src/style.css       … ダークテーマ (ui.md スタイルガイド準拠)
docs/specification/ … 仕様書
```
