# JSPaint — Inpainting Pre-processing Paint Tool (UI Mock)

Stable Diffusion Web UI (Forge / A1111) などの **inpainting 前処理**として iframe 埋め込みで使うことを想定した、
TypeScript 製の軽量ペイントツールです。本リポジトリは **UI モック** (実際にブラシ描画・選択・エクスポートが動作するデモ) を提供します。
UI仕様の詳細は [docs/specification/ui.md](docs/specification/ui.md) を参照してください。

## 起動方法

```bash
npm install
npm run dev          # 開発サーバ (http://localhost:5173)
npm run build        # dist/index.html — 単一HTML (依存なし・file:// ダブルクリックで起動可)
npm run typecheck    # tsc --noEmit
npm run test:puppet  # パペットワープ pure ロジックの単体検証 (node)
npm run test:meshwarp # メッシュワープ (Coons パッチ等 pure ロジック + E2E) の検証 (要 build 済み)
npm run test:imageio # 画像入出力 & ホストモードの E2E 検証 (ヘッドレス Chrome/Edge, 要 build 済み)
npm run test:hostbridge # ホスト連携 (JSPAINT_LOAD / JSPAINT_EXPORT) の E2E 検証 (ヘッドレス Chrome/Edge, 要 build 済み)
npm run test:tooltab # ツール選択時の「ツール」タブ自動切替の E2E 検証 (ヘッドレス Chrome/Edge, 要 build 済み)
npm run test:aisubject # AI被写体選択 (スタブONNX + IndexedDB キャッシュ込み) の E2E 検証 (ヘッドレス Chrome/Edge, 要 build 済み)
```

ビルド成果物は `dist/index.html` の **1ファイルのみ**。`vite-plugin-singlefile` により JS/CSS がすべてインライン化されるため、
単体で動作します (オフライン OK / デモ画像はCanvasで自動生成)。

## 実装内容

| エリア | 内容 |
|---|---|
| Header | **開く/保存/クリップボードコピー**、Undo/Redo、ズーム (5%〜800%)、フィット、ドキュメント情報、キャンセル/完了 |
| Toolbox | ブラシ・消しゴム・バケツ / 指先・**膨張**・覆い焼き/焼き込み・フィルターペン / **パペットワープ・メッシュワープ** (階層ボタン) / 直線・矩形・円 (**階層ボタンに集約**) / 矩形・投げ縄・多角形・魔法の杖・**AI被写体選択**・選択ペン / スポイト・手のひら + 前景/背景色 |
| Workspace | チェッカーボード + **可変サイズのステージ** (画像読み込みで実寸に追従)。パン (Space/中ボタン/手のひら)、ズーム (ホイール)、**画像のドラッグ&ドロップ読み込み** |
| Properties | ①ツール設定 (サイズ・不透明度・許容度・選択合成モード) ②前処理フィルター ③レイヤー (**ツール選択で自動的に「ツール」タブへ切替**) |
| StatusBar | ツール名、X/Y座標、操作ガイド、バージョン |
| Export Modal | 合成画像 & 白黒マスクのプレビュー、PNG保存、`postMessage({ type: 'JSPAINT_EXPORT', ... })` |

### 動作する主な機能 (モック範囲)

- ブラシ / 消しゴム / 図形 / 塗りつぶし (スキャンライン flood fill・許容度対応)
- 矩形・投げ縄・多角形 (**クリック=頂点追加 / ドラッグ=フリーハンド**)・魔法の杖による選択
- **選択ペン** (`K`): ドラッグで選択マスクを直接描画 (追加/除外モード対応)
- **AI被写体選択** (`A`): クリックしたポイントをヒントに SlimSAM がオブジェクトのマスクを生成する**対話型セグメンテーション**。
  追加クリックでマスクを改善、Alt+クリックで領域を除外。ランタイム (onnxruntime-web) は単一HTMLへ同梱、
  モデル (SlimSAM ×2ファイル / Apache-2.0) は初回のみ読み込んで IndexedDB にキャッシュ。
  詳細は [docs/specification/ai-subject-select.md](docs/specification/ai-subject-select.md)
- **膨張ブラシ** (`V`): ブラシ中心を基準にピクセルを放射状に押し広げるリキフィ系ツール。**押しっぱなしにしている間、その場で時間ベースに持続適用**され、ドラッグで膨らませる位置を移動できる。「効果の方向」で膨張 / 収縮を切替 (Alt で一時反転)。サイズ = radius、強さ = strength。選択範囲限定・編集対象レイヤー複数適用・Undo対応
- **フィルターペン** (`F`): フィルタータブで有効中のフィルターを、ペンでなぞった範囲に直接焼き込む (サイズ・適用の強さ・選択範囲限定 / 1ストローク内では効果が一定)
- 選択合成モード: 新規 / ＋追加 (Shift) / −除外 (Alt)
- **選択範囲の塗りつぶし** (`Alt+Delete`)・解除 (`Ctrl+D`)・範囲内消去 (`Delete`)
- **前処理フィルター**: ぼかし / **シャープ (アンシャープマスク)** / **ノイズ (0-100%, シード固定の決定論的グレイン — カラー / グレー切替、既定はカラー)** / 明るさ / コントラスト / 彩度 / 色相
  - 選択範囲がある場合は**その範囲のみ**適用 (プレビュー/エクスポート両方)
  - **確定(ベイク)** で背景レイヤーに焼き込み、フィルター設定をリセット (Undo対応)
- **Marching Ants**: 白黒マスクから境界ピクセルを抽出し、4相パターンでアニメーション
- レイヤー (背景=フィルター適用対象 + ペイントレイヤー)、可視性・複製・削除
- Undo / Redo (Ctrl+Z / Ctrl+Y)
- エクスポート: 背景フィルター+全レイヤーの合成画像、黒背景+白二値のマスク画像
- **画像入出力**: 「開く」(file dialog) / ドラッグ&ドロップ / `Ctrl+V` で画像を読み込み
  (ドキュメントは読み込み画像の実寸に変わり、選択・履歴・フィルターをリセット)、
  「保存」(合成画像 PNG) / 「コピー」(クリップボードへ `image/png`)
- **ホストモード**: `?mode=embed` (iframe 自動判定あり) で埋め込まれた場合は「開く/保存」を非表示にし、
  クリップボード・ペースト・postMessage 連携に専念する (standalone では全機能を表示)

### ショートカット

`B/E/G/S/V/D/J/F/L/U/O/M/Q/P/W/K/I/H` ツール切替 · `X` 色入替 · `[` `]` ブラシサイズ ·
`Ctrl+Z/Y` Undo/Redo · `Ctrl+A` すべて選択 · `Ctrl+D` 選択解除 · `Alt+Delete` 選択範囲を塗りつぶし ·
`Delete` 選択範囲を消去 · `0` 100% · `1` フィット · `Ctrl+Enter` エクスポート ·
`Ctrl+V` 画像を貼り付け · `Ctrl+S` PNG保存 (standalone) · `Ctrl+Shift+C` クリップボードへコピー

詳細な仕様は [docs/specification/ui.md](docs/specification/ui.md)、進捗は [docs/PROGRESS.md](docs/PROGRESS.md) を参照。

## 親アプリ連携 (仕様)

### ホストモード

| モード | 指定方法 | 挙動 |
|---|---|---|
| standalone | `?mode=standalone` / iframe 外 (既定) | 全機能 (開く・保存・コピー) を表示 |
| embed | `?mode=embed` / iframe 内自動判定 | 「開く」「保存」を非表示。画像は親アプリから受け取る前提 |

### 読み込み (親アプリ → 本ツール)

embed 時は親アプリからの次のメッセージを受け付けます (`ui/hostBridge.ts`):

```ts
window.addEventListener("message", (e) => {
  // e.data:
  {
    type: "JSPAINT_LOAD",
    image: dataURL, // 元画像 (ドキュメント差し替え) — 必須
    mask?: dataURL, // Inpaintingマスク (黒=描画なし / 白=描画あり) — 任意。
                    // 白の輝度を不透明度に変換し、「Inpaintマスク」レイヤーとして追加 +
                    // Inpainting マスクレイヤーに指定 (ui/layersPanel.ts のボタンで変更可)
    name?: string,  // ドキュメント名
  }
});
```

### Inpainting マスクレイヤー指定

レイヤーパネルの各レイヤーにマスク指定ボタン (杖アイコン) があり、**1 枚のみ**
Inpainting マスクレイヤーとして指定できる。指定レイヤーには「マスク」バッジが付く。

指定レイヤーはキャンバス上に **SD WebUI Forge と同様の白黒チェッカー (10px) × 50% 不透明度の
ドット網掛**で表示され、レイヤーサムネイルも同じドット網掛に統一される。
描画色・不透明度に関係なく表示はドットに統一され、
レイヤーの実データ (色・アルファ) とエクスポートされるマスク画像には影響しない (表示のみの変換)。

| マスク指定 | エクスポート時のマスク生成 |
|---|---|
| 指定あり | **そのレイヤーのみ**から生成 (不透明ピクセル = 白。選択範囲は含めない) |
| 指定なし | 従来どおり: 全ペイントレイヤー (可視) + 最終選択範囲 |

### エクスポート

iframe で埋め込み、「完了 (Export)」→「親アプリへ送信」で次のメッセージを送信します:

```ts
window.parent.postMessage({
  type: "JSPAINT_EXPORT",
  compositeImage: dataURL, // 合成画像 (背景+フィルター+ペイントレイヤー)
  maskImage: dataURL,      // Inpaintingマスク (黒=維持 / 白=再生成)
}, "*");
```

standalone (file:// 直開き) の場合は iframe 未検出を検出し、PNG ダウンロードへ誘導します。

## 構成

```
index.html              … UI骨格
src/main.ts             … エントリ
src/app.ts              … 生成と配線
src/core/               … ドメインロジック (ストア / 画像読み込み / フィルター / 選択 / Undo / ビュー変換)
src/painting/           … 描画系ツール
src/puppet/             … パペットワープ (メッシュ変形)
src/rendering/          … キャンバス描画
src/interaction/        … ポインタ・キーボード入力
src/ui/                 … DOM 配線 (パネル / 画像入出力 / ホストモード / エクスポート)
src/assets/             … アイコン・デモ画像
docs/specification/     … 仕様書
```
