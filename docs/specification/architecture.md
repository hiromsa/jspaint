# JSPaint アーキテクチャ (モジュール構成)

本ドキュメントは JSPaint のソースコード構成、モジュール間の依存方向、状態管理の設計方針を記録する。

(v0.1.4 — 元の単一ファイル `app.ts` (約2,240行) を機能単位へ分割したリファクタリングで導入)

---

## 1. ディレクトリ構成

```
src/
  main.ts            エントリポイント (startApp を呼ぶだけ)
  app.ts             アプリの生成と配線のみ (~90行)
  style.css          スタイル (ui.md スタイルガイド準拠・単一ファイルのまま)

  assets/            静的リソース生成
    demo.ts          デモ画像のCanvas生成 (外部依存なし・file:// 対応)
    icons.ts         lucide 由来アイコン定義 + mountIcons()

  core/              UI に依存しないドメインロジック
    types.ts         共有型 (ToolId / SelMode / Layer / Pt / EditorHooks) + 既定サイズ DOC_W/H
    editorState.ts   ユーザー設定・ビュー状態 (state オブジェクト)
    interactionState.ts  ポインタ操作中の経過状態 (interaction オブジェクト)
    toolDefs.ts      ツールのメタ定義 (TOOLS / TOOL_ICON / KEY_TOOL / PAINT_TOOLS)
    canvasUtils.ts   canvas 純粋ユーティリティ (clone / tintMask / floodMask / roundRectPath / hexA /
                     regionBounds: 領域判定関数から外接矩形 — パペット / メッシュワープ共用)
                     ※ ドキュメント可変化のため createCanvas はサイズ必須・floodMask は引数 canvas からサイズ取得
    imageSource.ts   画像ソースの読み込み (File / Blob → canvas 化・非同期)
    clipboard.ts     選択範囲のコピー / 切り取り / 新規レイヤー貼り付け (内部クリップボード)
    documentStore.ts レイヤー配列・アクティブ・編集対象・**ドキュメント実寸 (width/height)・名前**の管理
                     + 合成画像生成 + loadAsDocument / addImageLayer / toggleLock / resetToInitial (doc)
                     ※ レイヤー種別は image (元画像・編集可) / paint (マスク生成対象)。ロック中は編集対象から除外
    documentOps.ts   ストア間の複合操作 (applyBaseImage: 画像でドキュメントを読み直す /
                     resetDocument: 読み込み直後の状態へ戻す)
    selectionStore.ts 選択マスク・Marching Ants の管理 (selection) ※ resizeTo でドキュメント実寸に追従
    historyStack.ts  Undo / Redo (スナップショット方式・40ステップ) (history)
    filterEngine.ts  フィルター設定の保持と適用。基底クラス FilterSettings (パラメータ保持 + CSS filter 文字列生成 + ノイズ生成
                     + シャープ applySharpen) を全体フィルター FilterEngine (**編集対象レイヤーへのプレビュー layerPreview・ベイク**,
                     filters) とフィルターペン専用設定 filterPenFx で共用
                     ※ シャープは CSS filter に存在しないためアンシャープマスク (blur 参照との差分加算・premultiply 計算) を自前実装し、
                       プレビュー / ベイク / フィルターペンは applySharpen 済み canvas をソースに使う
                     ※ onDocResized でノイズキャッシュ (実寸依存) を無効化
    selectionOps.ts  選択範囲への編集操作 (全選択 / 塗りつぶし / 消去 / 解除)
    viewState.ts     ビューポート・ズーム / パン・screen⇔doc 変換 (viewport)
    hooks.ts         UI へのコールバック窓口 (hooks / setHooks)

  painting/          描画系ツールの実装
    stroke.ts        ストローク共通 (paintStroke + 選択範囲クリップ合成)
    retouch.ts       指先 / 覆い焼き / 焼き込み
    bloat.ts         膨張ブラシ (逆マッピング + rAF ホールドループ)
    filterPen.ts     フィルターペン (専用設定 filterPenFx をなぞった範囲に焼き込む — フィルタータブとは独立)

  puppet/            パペットワープ (メッシュ自由変形) の実装
    delaunay.ts      Bowyer-Watson 法による Delaunay 三角分割 (外部依存ゼロ)
    mesh.ts          メッシュ生成 (不透明領域 × 選択範囲 → グリッド + 輪郭点 → 三角分割) と
                     PuppetPin / PuppetMesh 型 (canvas 非依存・単体検証可)
                     ※ buildMesh は走査範囲 (width / height) を引数で受ける (可変ドキュメント対応)
    deformer.ts      MLS (Moving Least Squares) rigid 変形 — ピン移動から全頂点の変形先を計算
    warpPaint.ts     変形メッシュに沿った転写 (三角形転写は rendering/triangleTransfer.ts 共用)
    warpSession.ts   セッション管理 (開始 / ピン操作 / プレビュー / commit・cancel / Undo 統合)

  meshwarp/          メッシュワープ (ベジェメッシュによる面的歪み変形) の実装
    meshGrid.ts      完全グリッド (行 × 列のノード行列) と数理ロジック
                     (クーンズパッチ評価 / ド・カステリョ分割による列・行挿入 / エッジ直接ドラッグの
                      擬似逆行列分配 / ニュートン反復による逆写像 / スナップショット clone) — canvas 非依存・単体検証可
    warpPaint.ts     パッチを u / v 方向の小四角形に分割して「変形前 → 変形後」の対応三角形で転写
                     (転写本体は rendering/triangleTransfer.ts 共用)
    warpSession.ts   セッション管理 (開始 / ドラッグ種別 / ライン追加 / プレビュー / commit・cancel /
                     セッション内 Undo・Redo / Undo 統合)

  ai/                AI被写体選択 (SlimSAM 対話セグメンテーション) の実装
    ortRuntime.ts    onnxruntime-web の遅延ロードと wasm / ローダー mjs の Blob URL 接続
                     (単一HTML同梱 — vite.config.ts の #ort-* エイリアス参照)
    modelStore.ts    モデル (.onnx) の IndexedDB キャッシュ (キー汎用 / 不可環境はメモリフォールバック)
    modelSources.ts  モデルのダウンロード元データ (セットアップモーダルで描画)
    samSegmenter.ts  SlimSAM エンコーダ (画像→埋め込み) とデコーダ (ポイント→logits) のセッション管理
    samController.ts ポイント指定→マスク生成→選択範囲反映の制御 + 埋め込みキャッシュ

  rendering/         キャンバスへの描画
    renderer.ts      view canvas の管理と render() 本体
    previews.ts      オーバーレイ (プレビュー / メッシュ・ピン / メッシュワープのエッジ・ノード・ハンドル /
                     サイズバッジ / 円形カーソル)
    triangleTransfer.ts  src 三角形 → dst 三角形 のアフィン転写 (シーム防止パッド付き・パペット / メッシュ共用)

  interaction/       入力処理
    pointer.ts       ポインタイベントのツール別ディスパッチ / パン / ホイール
    keyboard.ts      ショートカット

  ui/                DOM 配線 (ロジックを持たない)
    dom.ts           $ / $$ / paintRangeFill
    feedback.ts      toast / markDirty / markClean
    hostMode.ts      ホストモード (standalone / embed) の判定と <html data-host-mode> 設定
    imageIO.ts       画像の入出力配線 (開く / 保存 / クリップボードコピー / Ctrl+V・Ctrl+Shift+V / ドラッグ&ドロップ
                     / 「クリップボードから新規作成」ボタン)
    panels.ts        ツールボックス・パラメータ・カラー・タブ
    layersPanel.ts   レイヤーパネル (ロック切替 / 表示・非表示 / 編集対象バッジ)
    filtersPanel.ts  フィルター設定 UI (data-fx-scope コンテナ単位でフィルタータブ / ツールタブのペン用を共通実装で bind・sync)
    exportModal.ts   ヘッダー操作 + Export モーダル (postMessage 連携) + キャンセル (初期状態へ復元)
```

## 2. 依存方向のルール

```
main.ts → app.ts ─┬→ ui/ ──────┐
                  ├→ interaction/ ──→ painting/ ─┐
                  ├→ rendering/ ────┘            ├→ core/
                  ├→ puppet/ ────────────────────┘
                  ├→ meshwarp/ ──────────────────┘
                  └→ core/ ──────────────────────┘
```

- **core は ui / rendering / interaction に依存しない** (DOM を触らない)。
- **puppet/ / meshwarp/ は painting/ 同等のドメイン層**。interaction / rendering / ui から参照され、core へ依存する。
  puppet/mesh.ts / delaunay.ts / deformer.ts、meshwarp/meshGrid.ts は canvas 非依存の純粋ロジック
  (`scripts/verify-puppet.ts` / `scripts/verify-meshwarp.ts` を `npm run test:puppet` /
  `npm run test:meshwarp` で単体検証できる)。両層とも `rendering/triangleTransfer.ts` の
  三角形転写共用実装を使用する (機能層 → rendering の参照。双方向にはならない)。
- core から UI 更新 (render / toast / パネル同期) を依頼する場合は **hooks** (`core/hooks.ts`) 経由。
  実装は `app.ts` の `startApp()` で `setHooks()` により差し込む (既定は no-op)。
- 依存は上の層から下の層へ一方向。循環 import は存在しない
  (背景レイヤーのフィルター描画は `doc.setBasePainter()` による注入で循環を回避)。

## 3. 状態管理の方針

| 種別 | 保持場所 | 例 |
|---|---|---|
| ストア (クラスのシングルトン) | core | `doc` / `selection` / `history` / `filters` |
| 設定・ビュー状態 (不変オブジェクトのプロパティ更新) | core | `state` (editorState) |
| 操作中の一時状態 (同上) | core | `interaction` (interactionState) |
| モジュール内プライベート | 各モジュール | フィルターペンの基準スナップショット等 |

- シングルトンは `export const doc = new DocumentStore()` の形で各 core モジュールが提供し、
  アプリ全体で共有する。クラス自体も export しており、単体テストでは new して隔離できる。
- `state` / `interaction` はプロパティのみ更新する不変オブジェクトとして複数モジュール間で共有
  (ES モジュールの `let` 再エクスポート制約を回避するパターン)。

## 4. データフロー例: ブラシストローク1本

```
pointerdown (interaction/pointer.ts)
  → history.pushUndo()            [core/historyStack: 対象レイヤー + 選択のスナップ]
  → paintStroke()                 [painting/stroke: 選択範囲があればクリップ合成]
  → interaction.strokeLast 更新   [core/interactionState]
pointermove → 同様に paintStroke → render()
pointerup   → 後始末 → render()
```

`render()` (rendering/renderer.ts) は `doc` / `filters` / `selection` / `interaction` を読んで
1フレームを描画する。Marching Ants のアニメーションは `selection.startAntLoop()` が
`hooks.render()` を 120ms 間隔で呼ぶことで回る。

## 5. 設計上の決定事項

- **hooks パターン**: core → UI の逆依存を防ぐため、UI コールバックは 1 箇所
  (`EditorHooks`) に集約。UI 実装の差し替え (例: 将来的な仮想 DOM 化) は setHooks だけで可能。
- **floodMask の純関数化**: バケツ / 魔法の杖は `floodMask(composite, x, y, tolerance)` と
  合成画像を引数で受け取る純粋関数にし、core/canvasUtils から documentStore への依存を切断。
- **style.css は分割しない**: 単一HTMLビルド (vite-plugin-singlefile) では分割の恩恵が小さく、
  ui.md スタイルガイドとの対応が分かりにくくなるため現状維持。
- **可変ドキュメントサイズ** (v0.2.0): ドキュメント実寸は `doc.width` / `doc.height` で管理し、
  画像読み込み (開く / ドロップ / Ctrl+V) で読み込み画像の実寸に追従する。
  - 各モジュールの DOC_W/H 固定参照は `doc.width/height` か、対象 canvas の実寸
    (`ctx.canvas.width` / `target.canvas.width`) へ置換。painting 層は依存を増やさないため後者を採用。
  - `canvasUtils.createCanvas(w, h)` はサイズ必須引数に変更 (既定サイズを持たない)。
  - 画像適用 (`documentOps.applyBaseImage`) では選択マスク (`selection.resizeTo`)・Undo 履歴
    (`history.clear`)・フィルター (`filters.resetValues + onDocResized`) をまとめてリセットする。
    異なるサイズのスナップショット混在による復元破綻を避けるため、履歴は「読み込みでクリア」方針。
  - `types.ts` の DOC_W/H はデモ画像生成用の「既定の初期サイズ」としてのみ残存。
- **ホストモード (standalone / embed)** (v0.2.0): 呼び出され方によって利用可能な I/O を切り替える。
  - 判定は `ui/hostMode.ts` に集約。URL パラメータ `?mode=embed|standalone` を最優先とし、
    未指定時は iframe 有無で自動判定 (SD Web UI 等からの埋め込みを想定)。
  - UI の出し分けは `<html data-host-mode>` + CSS 属性セレクタで宣言的に行う
    (`[data-standalone-only]` を embed で非表示)。JS 側の個別分岐は最小限。
  - 画像適用・保存・コピーの実体は core (`documentOps`) / ui (`imageIO`) に分離し、
    モードは「どのボタンを表示するか」にのみ影響する (ロジック自体はモード非依存)。
- **レイヤーモデルの統一 (Photoshop ライク化)** (v0.2.1):
  - レイヤー種別は `image` (元画像・**編集・複製・削除可**) と `paint` (描画要素) の 2 種。
    起動 / ドキュメント差し替え時は image レイヤー 1 枚のみで開始する。
  - **Inpainting マスクは paint レイヤー (+選択範囲) からのみ生成** (元画像は白化しない)。
    SD Web UI 連携のプロトコルを維持するための区別であり、UI 上の制限 (ロック等) とは独立。
  - レイヤー操作: 追加 / 複製 / 削除 (最低 1 枚) / 表示非表示 / **ロック** / 編集対象 (Ctrl+クリック)。
    ロック中のレイヤーは `editTargets()` から除外されるため、描画・レタッチ・フィルター・パペットワープが
    自動的に対象外になる。
  - **フィルターの適用先は編集対象レイヤー**。プレビューは `filterEngine.layerPreview(l)` が
    編集対象レイヤーのみフィルター適用済み canvas を返し、renderer がそれに差し替えて描画する
    (旧 drawBaseLayer の背景固定ロジックを置換)。ベイクも編集対象レイヤー全てに焼き込む。
  - **レイヤー指向のコピーペースト** (`core/clipboard.ts`): Ctrl+C/X で編集対象レイヤーの合成 × 選択範囲を
    内部クリップボードへ (不透明 bbox で切り抜き・元位置を記憶)、Ctrl+V で元位置の新規レイヤーに貼り付け。
  - **ペーストとドキュメント差し替えの分離**: Ctrl+V = 新規レイヤー貼り付け (内部優先 → 外部画像)、
    Ctrl+Shift+V / 「開く」/ ドロップ = ドキュメント差し替え (`documentOps.applyBaseImage`)。
    paste イベントは修飾キー情報を持たないため、keydown で Shift 状態を記録して判定する
    (`interaction.pasteShift`)。
  - 「キャンセル」ボタンは読み込み直後の初期状態へ復元 (`doc.resetToInitial` +
    `documentOps.resetDocument`: 選択・履歴・フィルターリセット込み)。
- **パペットワープは外部依存ゼロ** (v0.1.6): Delaunay 分割は Bowyer-Watson 法を自前実装
  (`puppet/delaunay.ts`)。頂点数は数百規模でセッション開始時 1 回のみ実行のため素朴な実装で十分。
  変形計算は MLS rigid (加重 2D Procrustes の解析解: θ = atan2(Σw·(P̂×Q̂), Σw·(P̂·Q̂))、
  f(v) = q* + R·(v − p*))。レンダリングは三角形ごとの「クリップ + アフィン変換」転写で、
  クリップパスを 0.5px 膨張して三角形境界のシームを防止。
- **パペットワープのセッション分離** (`puppet/warpSession.ts`): 開始時に編集対象レイヤーの
  スナップショットを取り、プレビューはスナップショット上でのみ計算する。レイヤーの実ピクセルは
  commit (Enter / ツール切替時の自動確定) まで一切変更しないため、Undo エントリは確定時 1 回のみ。
  メッシュワープ (`meshwarp/warpSession.ts`) も同一のセッションモデルに従う。
- **メッシュワープは Coons パッチ + 完全グリッド (行 × 列)** (v0.2.22 / v0.2.23):
  - ノードを `[行][列]` の行列で管理する**完全グリッド**。パッチは隣接 4 ノードから動的に導出するため
    T ジャンクションは発生しない。ポイント追加 (エッジ / パッチ内のダブルクリック) は**新しい列 / 行の挿入**として
    実装され、ラインは最初の矩形の幅・高さまで**グリッド全体に貫通**する。
  - ライン追加はド・カステリョ分割で行い、分割後の 2 セグメント `[P0, L1, L2, C]` / `[C, R2, R1, P3]` が
    元曲線を正確に継承するよう、両端ノードのハンドルを部分曲線の制御点 (L1 / R1) へ更新し、
    キーを新ノード方向へ付け替える (分割前後で曲線形状は不変)。
  - ハンドル未設定の辺は「P1 = P0+Δ/3、P2 = P3−Δ/3」の制御点で**真の直線**として評価する
    (P1 = P0 / P2 = P3 の 3 次ベジェは直線にならずパラメータが非線形になるため)。
  - 転写はパッチを u / v グリッド (セグメント数に比例、4〜32 分割) でサンプリングし、
    「home → pos」の対応三角形をアフィン転写する (MLS 三角形転写と共用の実装)。
  - **セッション内 Undo / Redo**: ドラッグ 1 回 / ライン追加 1 回を 1 操作としてグリッドのスナップショット
    (`MeshWarpGrid.clone()`) を最大 40 ステップ積む。セッション中の `Ctrl+Z` / `Ctrl+Y` はセッション内履歴を
    優先し、ツール開始時の状態まで戻せる (確定後は従来どおりドキュメント履歴で戻る)。
  - `T` キーはパペットワープ / メッシュワープで共有し (`KEY_TOGGLE_NEXT`)、押下ごとに相互切替する。
- **フィルターペンの設定は全体フィルターと独立** (v0.2.3): 従来はフィルターペンがフィルタータブ
  (FilterEngine) の状態を共用していたため、「ペンだけ使いたいのにフィルターを ON にした瞬間に
  画像全体へプレビューがかかる / 確定 (ベイク) と干渉する」問題があった。
  - `FilterSettings` 基底クラス (パラメータ保持 + CSS filter 文字列 + ノイズ生成) を新設し、
    全体フィルター `FilterEngine` (プレビュー / ベイク) とフィルターペン専用 `filterPenFx`
    (焼き込み) で共用。効果生成ロジックは一元化される。
  - UI は `data-fx-scope` 属性を持つコンテナ単位で共通実装 (`ui/filtersPanel.ts` の
    `bindFxScope` / `syncFxScope`) により bind・sync する。フィルタータブ = `image`、
    ツールタブのペン用 = `pen` (data-show="filter-pen" で選択時のみ表示)。UI の二重実装はなし。
  - ペン設定はドキュメント差し替え時も値を保持する (ツールオプション扱い)。
    ノイズキャッシュのみ実寸依存のため `filterPenFx.onDocResized()` で無効化する。
  - ペン設定がすべて無効のときのストロークは toast で「ツールタブで有効化」を案内する。
- **AI被写体選択は onnxruntime-web を単一HTMLへ同梱** (v0.2.18 / SlimSAM 化):
  - ランタイムは「wasm 外部渡し」ビルド (`ort.min.mjs`) を使用。bundle 版は内部の
    `new URL(..., import.meta.url)` が Vite により全箇所 data URI 化され、同一 wasm が複数埋め込まれて
    約3倍に膨らむため、`vite.config.ts` の `#ort-*` エイリアスで素パス解決して `?url` インラインし、
    実行時に Blob URL 化して `ort.env.wasm.wasmPaths` へ渡す (file:// 相対参照は CORS でブロックされる)。
  - **モデル (SlimSAM ×2ファイル、合計約40MB) は同梱しない**。初回のみユーザーが読み込み、IndexedDB
    (`jspaint.ai`) にキャッシュする。file:// でも IndexedDB は永続化される (E2E で検証)。
  - セグメンテーションは**プロンプト可能な SAM 方式**: クリックポイント (陽性 / Alt+クリックで陰性) を
    デコーダに与えてマスク logits を得る (IoU 最大候補を採用 / logits > 0 で確定)。
    画像埋め込みは「ドキュメントサイズ + 編集リビジョン」でキャッシュし、ポイント反復はデコーダのみ再実行。
    ポイント座標は埋め込み準備時にドキュメント変更を検知した場合のみクリアする (0ポイント デコード防止のため
    push はクリア後に行う)。
  - モデルは SlimSAM-77-uniform 変換版 (Xenova / Apache-2.0) の 2ファイル。セットアップモーダル
    (`src/ai/modelSources.ts` から描画) がダウンロード元を案内する。
  - 詳細仕様は [ai-subject-select.md](./ai-subject-select.md) を参照。

## 6. 検証スクリプト

- `npm run test:puppet` — パペットワープの pure ロジック (Delaunay / メッシュ / MLS) を node で単体検証 (25 ケース)。
- `npm run test:meshwarp` — メッシュワープの検証 (合計 60 ケース / 2 パート構成)。
  - Part 1: 純粋ロジック (クーンズパッチ評価 / ハンドル付きエッジ / 列・行挿入 (ド・カステリョ分割) の形状不変性 /
    ライン追加の全体貫通 / エッジ直接ドラッグの「吸いつき」/ 逆写像の往復精度 / スナップショット clone の独立性) を node で単体検証 (46 ケース)。
  - Part 2: 実ブラウザ E2E (事前に `npm run build` が必要)。スタックポップからの選択 / セッション開始 /
    エッジドラッグ → **セッション中の変形プレビュー表示** / `Ctrl+Z` (セッション内 Undo) → 元画像に戻る /
    `Ctrl+Y` (Redo) / Enter 確定のピクセル変化 / 確定後のドキュメント履歴 Undo / ダブルクリックによるライン追加 /
    Esc 取消 / `T` キーでのパペット ⇔ メッシュワープ相互切替を検証する (14 ケース)。
    (puppeteer の `clickCount: 2` は dblclick を合成しないため、ダブルクリックは `dispatchEvent` で発火させる)
- `npm run test:imageio` — 画像入出力とホストモードをヘッドレス Chrome / Edge で E2E 検証 (27 ケース相当)。
  - 事前に `npm run build` が必要。puppeteer-core (devDependencies) を使用し、
    インストール済みブラウザの実行ファイルを自動検出する (追加ダウンロード不要)。
- `npm run test:filterpen` — フィルターペン専用設定 (ツールタブ) とシャープフィルターの E2E 検証 (29 ケース相当)。
  フィルタータブとの独立性 / ペン有効化で画像全体が変わらないこと / なぞった範囲のみ焼き込まれること /
  全体フィルターの従来動作 (プレビュー / 非破壊) / 無効時の案内トースト /
  シャープ (ペンの範囲焼き込み / 全体プレビュー・非破壊 / ベイクと設定リセット) を検証する。
- `npm run test:aisubject` — AI被写体選択の E2E 検証 (11 ケース相当)。
  スタブ ONNX (`scripts/fixtures/` — `python scripts/make_stub_sam.py` で生成する
  「チャンネル平均を埋め込み / logits として返す」SlimSAM 互換の最小モデル ×2) を使い、
  本物のモデルなしで 単一HTMLの単一性 / ツール選択とステータス遷移 / セットアップモーダル /
  ポイント選択 (追加・クリア・確定) / **IndexedDB 永続化** (リロード後の自動ウォームアップ) / モデル削除を検証する。
  実モデルでの推論経路は `node scripts/check-slimsam.cjs` で確認できる (models/slimsam/ に配置が必要)。
