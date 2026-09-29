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
    canvasUtils.ts   canvas 純粋ユーティリティ (clone / tintMask / floodMask / roundRectPath / hexA)
                     ※ ドキュメント可変化のため createCanvas はサイズ必須・floodMask は引数 canvas からサイズ取得
    imageSource.ts   画像ソースの読み込み (File / Blob → canvas 化・非同期)
    documentStore.ts レイヤー配列・アクティブ・編集対象・**ドキュメント実寸 (width/height)・名前**の管理
                     + 合成画像生成 + replaceBaseImage (doc)
    documentOps.ts   ストア間の複合操作 (applyBaseImage: 画像をベースとして適用し
                     選択 / 履歴 / フィルターをリセットして fit)
    selectionStore.ts 選択マスク・Marching Ants の管理 (selection) ※ resizeTo でドキュメント実寸に追従
    historyStack.ts  Undo / Redo (スナップショット方式・40ステップ) (history)
    filterEngine.ts  前処理フィルターの状態・適用・ベイク (filters) ※ onDocResized でキャッシュ無効化
    selectionOps.ts  選択範囲への編集操作 (全選択 / 塗りつぶし / 消去 / 解除)
    viewState.ts     ビューポート・ズーム / パン・screen⇔doc 変換 (viewport)
    hooks.ts         UI へのコールバック窓口 (hooks / setHooks)

  painting/          描画系ツールの実装
    stroke.ts        ストローク共通 (paintStroke + 選択範囲クリップ合成)
    retouch.ts       指先 / 覆い焼き / 焼き込み
    bloat.ts         膨張ブラシ (逆マッピング + rAF ホールドループ)
    filterPen.ts     フィルターペン

  puppet/            パペットワープ (メッシュ自由変形) の実装
    delaunay.ts      Bowyer-Watson 法による Delaunay 三角分割 (外部依存ゼロ)
    mesh.ts          メッシュ生成 (不透明領域 × 選択範囲 → グリッド + 輪郭点 → 三角分割) と
                     PuppetPin / PuppetMesh 型 (canvas 非依存・単体検証可)
    deformer.ts      MLS (Moving Least Squares) rigid 変形 — ピン移動から全頂点の変形先を計算
    warpPaint.ts     三角形クリップ + アフィン変換で元画像を転写 (シーム防止パッド付き)
    warpSession.ts   セッション管理 (開始 / ピン操作 / プレビュー / commit・cancel / Undo 統合)

  rendering/         キャンバスへの描画
    renderer.ts      view canvas の管理と render() 本体
    previews.ts      オーバーレイ (プレビュー / メッシュ・ピン / サイズバッジ / 円形カーソル)

  interaction/       入力処理
    pointer.ts       ポインタイベントのツール別ディスパッチ / パン / ホイール
    keyboard.ts      ショートカット

  ui/                DOM 配線 (ロジックを持たない)
    dom.ts           $ / $$ / paintRangeFill
    feedback.ts      toast / markDirty / markClean
    hostMode.ts      ホストモード (standalone / embed) の判定と <html data-host-mode> 設定
    imageIO.ts       画像の入出力配線 (開く / 保存 / クリップボードコピー / Ctrl+V / ドラッグ&ドロップ)
    panels.ts        ツールボックス・パラメータ・カラー・タブ
    layersPanel.ts   レイヤーパネル
    filtersPanel.ts  フィルタータブ
    exportModal.ts   ヘッダー操作 + Export モーダル (postMessage 連携)
```

## 2. 依存方向のルール

```
main.ts → app.ts ─┬→ ui/ ──────┐
                  ├→ interaction/ ──→ painting/ ─┐
                  ├→ rendering/ ────┘            ├→ core/
                  ├→ puppet/ ────────────────────┘
                  └→ core/ ──────────────────────┘
```

- **core は ui / rendering / interaction に依存しない** (DOM を触らない)。
- **puppet/ は painting/ 同等のドメイン層**。interaction / rendering / ui から参照され、core へ依存する。
  mesh.ts / delaunay.ts / deformer.ts は canvas 非依存の純粋ロジック (`scripts/verify-puppet.ts` を
  `npm run test:puppet` で単体検証できる)。
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
- **パペットワープは外部依存ゼロ** (v0.1.6): Delaunay 分割は Bowyer-Watson 法を自前実装
  (`puppet/delaunay.ts`)。頂点数は数百規模でセッション開始時 1 回のみ実行のため素朴な実装で十分。
  変形計算は MLS rigid (加重 2D Procrustes の解析解: θ = atan2(Σw·(P̂×Q̂), Σw·(P̂·Q̂))、
  f(v) = q* + R·(v − p*))。レンダリングは三角形ごとの「クリップ + アフィン変換」転写で、
  クリップパスを 0.5px 膨張して三角形境界のシームを防止。
- **パペットワープのセッション分離** (`puppet/warpSession.ts`): 開始時に編集対象レイヤーの
  スナップショットを取り、プレビューはスナップショット上でのみ計算する。レイヤーの実ピクセルは
  commit (Enter / ツール切替時の自動確定) まで一切変更しないため、Undo エントリは確定時 1 回のみ。

## 6. 検証スクリプト

- `npm run test:puppet` — パペットワープの pure ロジック (Delaunay / メッシュ / MLS) を node で単体検証 (22 ケース)。
- `npm run test:imageio` — 画像入出力とホストモードをヘッドレス Chrome / Edge で E2E 検証 (19 ケース相当)。
  - 事前に `npm run build` が必要。puppeteer-core (devDependencies) を使用し、
    インストール済みブラウザの実行ファイルを自動検出する (追加ダウンロード不要)。
