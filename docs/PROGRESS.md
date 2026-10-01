# JSPaint 進捗状況・計画

開発フェーズ、実装実績、セッション記録を管理します。

## 現在のフェーズ

**Phase 1: UI モック (動作デモ)** — 完成
TypeScript 実装の原型として、描画/選択/フィルター/エクスポートの核となる操作が一通り動作する状態。

## 実装実績

### 基盤
- Vite + TypeScript。ビルドは単一HTML (`vite-plugin-singlefile`, `dist/index.html`) で file:// 単体起動可
- Photoshop/Figma ライクな高密度ダークテーマ (ui.md スタイルガイド準拠)
- Header / Toolbox / Workspace / Properties(3タブ・**ツール選択で「ツール」タブへ自動切替**) / StatusBar + Export モーダル
- **モジュール構成** (詳細は [docs/specification/architecture.md](./specification/architecture.md)):
  `core/` (ストア・ロジック) / `painting/` (ツール) / `rendering/` (描画) / `interaction/` (入力) / `ui/` (DOM配線)。
  core→UI の逆依存は hooks (`core/hooks.ts`) 経由、`app.ts` は生成と配線のみ (~80行)

### キャンバスエンジン
- **可変ステージ**。「ドキュメント中心基準」の screen⇔doc 変換 (ズーム 5〜800%、パン、fit)。
  実寸は `doc.width` / `doc.height` で管理し、画像読み込みで読み込み画像の実寸に追従する
- チェッカーボード背景。デモ画像はCanvas自動生成 (外部依存なし・オフライン動作)

### 画像入出力 & ホストモード (v0.2.0)
- 読み込み: ヘッダー「開く」/ ワークスペースへのドラッグ&ドロップ (オーバーレイ付き) / `Ctrl+V` ペースト
- 出力: ヘッダー「保存」(合成画像 PNG) / 「コピー」(`navigator.clipboard` へ `image/png`)
- ホストモード: `?mode=embed|standalone` + iframe 自動判定で standalone 専用 UI (開く/保存) を出し分け
- 詳細は [ui.md 2.6](./specification/ui.md#26-画像入出力とホストモード-standalone--embed) / [architecture.md](./specification/architecture.md)

### 親アプリ連携 (Forge 拡張)
- **読み込みプロトコル `JSPAINT_LOAD`** (`ui/hostBridge.ts`): embed 時に親から
  `postMessage({ type: "JSPAINT_LOAD", image, mask?, name? })` を受信。
  `image` (dataURL) でドキュメントを差し替え、`mask` (黒=描画なし / 白=描画あり) は
  白の輝度を不透明度に変換した「Inpaintマスク」レイヤーとして追加し、
  **Inpainting マスクレイヤーに指定**する (カレントは元画像のまま)
- **Inpainting マスクレイヤー指定**: レイヤーパネルの杖ボタンでレイヤーを 1 枚だけ
  マスクに指定できる (指定レイヤーは緑の「マスク」バッジ + 行強調)。
  ドキュメント差し替え / キャンセル (初期化) / レイヤー削除時は指定が解除される
- **マスクレイヤーのドット網掛表示**: Inpainting マスク指定レイヤーはキャンバス上で
  SD WebUI Forge と同様の**白黒チェッカー (10px) × 50% 不透明度のドット網掛**で表示され、
  **レイヤーサムネイルも同じドット網掛に統一** (`rendering/maskDisplay.ts` の `drawMaskLayerThumb`)。
  描画色に関係なく表示はドットに統一され、レイヤーデータや
  エクスポートされるマスクには影響しない (表示のみの変換)。指定の付け替えは即時反映
  (`setInpaintMaskLayer` が render を呼ぶよう修正)。E2E: `npm run test:maskdisplay` (13 ケース合格)
- **エクスポートのマスク生成**: マスク指定レイヤーがある場合は**そのレイヤーのみ**から
  生成 (不透明ピクセル = 白。選択範囲は含めない)。未指定時は従来どおり
  全ペイントレイヤー (可視) + 最終選択範囲
- **compositeImage からマスクレイヤーを除外**: マスクは maskImage として別送出されるため、
  出力画像 (エクスポート / 保存 / コピー) には焼き込まない
  (キャンバス表示・バケツ塗り・スポイトの基準合成には影響なし)
- **送信後の自動復帰**: embed 時に「親アプリへ送信」成功後、送信済み表示を一瞬見せて
  Export モーダルを自動で閉じて描画画面へ戻る
- E2E: `npm run test:hostbridge` (親ページ + iframe embed で JSPAINT_LOAD → レイヤー指定 →
  JSPAINT_EXPORT 往復をピクセル検証、12 ケース合格)

### ツール
- ブラシ / 消しゴム (サイズ・不透明度)、直線 / 矩形 / 円 (Shift拘束・塗りつぶし切替)
- **ツール別サイズ記憶**: サイズ (1〜500px・既定 24px) はツールごとに独立して記憶し、ツール切替時に復元。localStorage (`jspaint.toolSizes.v1`) で永続化 (詳細は ui.md 2.3)
- 塗りつぶし (スキャンライン flood fill・許容度)
- 選択: 矩形 / 投げ縄 / 多角形 (クリック=頂点追加・ドラッグ=フリーハンド) / 魔法の杖 (許容度)
- 選択ペン (`K`): ドラッグでマスクを直接描画 (新規/追加/除外に連動)
- **AI被写体選択 (`A`)**: クリックしたポイントをヒントに SlimSAM がオブジェクトのマスクを生成する
  対話型セグメンテーション。ランタイム (onnxruntime-web) は単一HTMLへ同梱、モデル (SlimSAM ×2ファイル /
  Apache-2.0) は初回のみ読み込んで IndexedDB にキャッシュ
  (詳細は [ai-subject-select.md](specification/ai-subject-select.md) / 実装は `src/ai/`)
- スポイト、手のひら (`Space` 長押しパン)
- レタッチ (指先 / 覆い焼き / 焼き込み): 編集対象レイヤーのピクセルに直接作用 (元画像専用ではなくアクティブレイヤーでも使用可)
- フィルターペン (`F`): ツールタブの「フィルター効果」 (専用設定 `filterPenFx`) をペンでなぞった範囲に焼き込む (ストローク開始時の画像を基準にするため同一ストローク内で効果は一定。サイズ・適用の強さ・選択範囲限定・編集対象レイヤー複数適用・Undo対応)。**フィルタータブ (全体フィルター) とは独立**しており、ペン使用中も画像全体には影響しない
- 膨張ブラシ (`V`): 逆マッピング + premultiply バイリニア補間でブラシ中心を基準にピクセルを放射状に押し広げるリキフィ系ツール。押しっぱなしで時間ベースに持続適用 (rAF ホールドループが唯一の適用経路)、「効果の方向」で膨張 / 収縮切替・`Alt` 一時反転。選択範囲限定・編集対象レイヤー複数適用・Undo対応
- **パペットワープ (`T`)**: ピンを打ってメッシュ (Delaunay 三角分割) ごと画像を滑らかに変形するポーズ・アングル調整ツール。クリック=ピン追加 / Alt+クリック=固定ピン / ピンドラッグ=MLS rigid 変形のリアルタイムプレビュー / ダブルクリック=ピン削除 / Enter=確定 (Undo スナップショット後に焼き込み) / Esc=取消 / ツール切替=自動確定。メッシュは編集対象レイヤー合成の不透明領域 × 選択範囲から「外接矩形グリッド + 輪郭サンプル点」を自前実装 Bowyer-Watson Delaunay で分割 (外部依存ゼロ)、メッシュ間隔 16〜64px をパネルで調整。選択範囲限定・編集対象レイヤー複数適用対応 (詳細は [ui.md 2.4.1](./specification/ui.md#241-パペットワープ-puppet-warp) / [architecture.md](./specification/architecture.md))
- pure ロジック (Delaunay / メッシュ生成 / MLS 変形) の単体検証: `npm run test:puppet` (esbuild でバンドルして node 実行・18 ケース合格)
- 選択範囲がある場合、描画系ツール (ブラシ / 消しゴム / 塗りつぶし / 指先 / 膨張 / 覆い焼き / 焼き込み / フィルターペン / 直線 / 矩形 / 円) は選択範囲内のみ描画
- `Esc` キー: 多角形 / 投げ縄 / ドラッグ中プレビューの取消 → 選択範囲のクリア (最後に選択範囲を解除)

### 選択範囲
- Marching Ants: 白黒マスクから境界ピクセルを抽出し、4相パターンでアニメーション
- 選択合成モード: 新規 / ＋追加 (Shift) / −除外 (Alt)
- 選択範囲の塗りつぶし (`Alt+Delete`) / 解除 (`Ctrl+D`) / 範囲内消去 (`Delete`)
- 矩形選択・図形ツールのドラッグ中にサイズバッジを表示 (W×H、直線は長さ。選択範囲内のみ描画時はガイドに注記)
- 矩形選択のドラッグ中プレビュー: 範囲を色付きオーバーレイ + 白破線枠で表示 (新規=青 / 追加=緑 / 除外=赤、バッジにも ＋/− 記号)

### フィルター (Inpainting 前処理)
- ガウスぼかし / **シャープ (0〜100%, アンシャープマスク)** / ノイズ (0〜100%, シード固定の決定論的グレイン — **カラー / グレー切替・既定カラー**) / 明るさ / コントラスト / 彩度 / 色相回転
- **適用先は編集対象レイヤー** (v0.2.1 から背景固定を廃止)。選択範囲がある場合はその範囲のみ適用 (プレビュー / composite エクスポート両方)
- **確定 (ベイク)**: フィルター結果を編集対象レイヤーに焼き込み、設定をリセット (Undo対応)

### レイヤー / Undo
- **レイヤーモデル (v0.2.1・Photoshop ライク)**: 元画像レイヤー (image・**編集可**) と描画レイヤー (paint)。
  起動 / 読み込み時は image レイヤー 1 枚のみ。追加 / 複製 / 削除 (最低 1 枚) / 表示非表示 / **ロック** / 編集対象
  (Ctrl+クリック) を操作可。ロック中は描画・フィルター・編集対象から自動除外
- **選択範囲のコピーペースト** (`Ctrl+C`/`Ctrl+X`/`Ctrl+V`): 編集対象レイヤーの選択範囲を内部クリップボードへ
  コピー / 切り取りし、**元位置の新規レイヤー**として貼り付け (外部画像の Ctrl+V も新規レイヤー化)。
  Inpainting マスクは paint レイヤー + 選択範囲からのみ生成
- **フィルターの適用先は編集対象レイヤー** (プレビュー / ベイク)
- 背景 (フィルター適用対象) + ペイントレイヤー (追加 / 複製 / 削除 / 可視性) — v0.2.0 以前の構成
- **編集対象レイヤー (複数指定)**: レイヤーを Ctrl+クリックで編集対象に追加 / 解除。描画・レタッチ系ツール (ブラシ / 消しゴム / 塗りつぶし / 指先 / 覆い焼き / 焼き込み / 直線 / 矩形 / 円 / 選択範囲の塗りつぶし・Delete消去) は編集対象レイヤーすべてに適用される。対象はリストにバッジ表示、パネルヘッダーに対象数、ステータスガイドに「N レイヤーに適用」注記
- Undo / Redo (40ステップ、編集対象レイヤー全て + 選択状態のスナップショット。対象レイヤー指定可能・複数レイヤー復元対応)

### エクスポート
- 合成画像 (背景フィルター+全レイヤー) / 白黒マスク (描画要素+最終選択範囲) のプレビュー・PNG保存
- `postMessage({ type: 'JSPAINT_EXPORT', compositeImage, maskImage })` 送信 (単体時はダウンロード誘導)

## セッション記録 (修正履歴)

| # | 内容 |
|---|---|
| 1 | UI モック初版実装 (レイアウト・描画エンジン・選択・エクスポート) |
| 2 | ツールボックスのアイコンが表示されない不具合を修正 (`mountIcons` がパス文字列を `<path>` でラップしていなかった) |
| 3 | 描画位置がマウス座標の半分にずれる不具合を修正 (`screenToDoc` のドキュメント中心オフセット漏れ) |
| 4 | 選択ペン・選択範囲の塗りつぶし/解除・フィルターの選択範囲限定適用・ポリゴンのフリーハンドを追加 |
| 5 | フィルターの「確定(ベイク)」を追加。ノイズを 0〜100% の決定論的グレインに改良。docs 更新 |
| 6 | 矩形選択・図形ツールのドラッグ中サイズバッジ (W×H / 直線は長さ) を追加。選択範囲がある場合に描画系ツールが選択範囲内のみ描画されるよう制限 (`paintStroke` で selMask 切り抜き合成)。docs 更新 |
| 7 | レタッチツール (指先 / 覆い焼き / 焼き込み) が背景レイヤー固定で作用する不具合を修正 (編集対象レイヤーに作用)。編集対象レイヤーの複数指定 (Ctrl+クリック) を追加し、描画・レタッチ・選択範囲操作を対象レイヤー全体に適用。Undo/Redo を複数レイヤースナップショット対応に拡張。`Esc` キーで選択範囲クリア (進行中の選択操作は先に取消)。docs 更新 |
| 8 | ノイズフィルターにカラー / グレー切替を追加 (既定はカラー)。**フィルターペン (`F`)** を追加 — フィルタータブで有効中のフィルターを、ペンでなぞった範囲に直接焼き込むツール (1ストローク内は効果一定、選択範囲限定・複数レイヤー適用・Undo対応)。docs 更新 |
| 9 | **膨張ブラシ (`V`)** を追加 — ブラシ中心を基準にピクセルを放射状に押し広げるリキフィ系ツール (逆マッピング + premultiply バイリニア補間)。「押しっぱなしで時間ベースに持続適用」する rAF ホールドループ (ドラッグ時の全強度スタンプ連射を廃止し適用を一本化)、「効果の方向」(膨張 / 収縮) パラメータ、`Alt` 一時反転を実装。初回実装でバイリニア補間の**ハーフピクセル・オフセット** (インデックス化時に -0.5 せず、毎スタンプ (-0.5, -0.5) px のドリフトが蓄積して画像が左上へ流れる) を発見し修正。ヘッドレスブラウザ E2E (実ポインタイベント + ピクセル変位計測) で放射対称性を検証。docs 更新 |
| 10 | **機能単位へのリファクタリング** — 単一ファイルだった `app.ts` (約2,240行) を `core/` `painting/` `rendering/` `interaction/` `ui/` `assets/` の計25モジュールへ分割。状態はストア (doc / selection / history / filters) にカプセル化し、core→UI の逆依存は hooks パターンで解消 (`app.ts` は生成と配線のみ ~80行)。動作仕様は変更なし。検証は各ステップで `typecheck` + `build`。詳細は `docs/specification/architecture.md` を参照 |
| 11 | **パペットワープ (`T`) を追加** — ピン (制御点) を打ってメッシュごと画像を滑らかに変形するツール。`puppet/` 新層 (delaunay / mesh / deformer / warpPaint / warpSession) として実装。Delaunay は自前 Bowyer-Watson (依存ゼロ)、変形は MLS rigid (加重 2D Procrustes 解析解)、描画は三角形クリップ + アフィン転写 (0.5px パッドでシーム防止)。ピン追加 (クリック / Alt=固定)・ドラッグ変形・ダブルクリック削除・Enter 確定 / Esc 取消 / ツール切替自動確定、選択範囲限定・複数レイヤー適用・Undo 対応。pure ロジックの単体検証 `npm run test:puppet` を追加 (18 ケース合格、対角線退化ケースと MLS 理論挙動に期待値を合わせた)。typecheck + build 合格。docs 更新 (ui.md 2.4.1 / architecture.md puppet 層) |
| 12 | **変形済み状態でのピン打ち位置を修正** — これまで `addPin` はクリック位置 (変形後空間) をそのまま `original = current` として登録していたため、変形済みで打つと矛盾した制約が MLS に加わり画像がジャンプし「点がおかしな場所に配置される」ように見えていた。`mesh.ts` に `inverseDeformPoint` (変形後三角形の重心座標を初期三角形へ適用して初期空間へ逆変換) を追加し、`addPin` の `original` を逆変換結果にすることで「見た目の位置にピンが打てる・ピン追加だけでは画像が動かない」挙動に修正。単体検証 4 ケース追加 (合計 22 合格・変形後固定ピンでの変形ドリフト <1px を確認)。docs 更新 |
| 13 | **画像入出力 + ホストモード + 可変ドキュメントサイズを追加** — ①画像の読み込み 3 経路 (ヘッダー「開く」/ ワークスペースへのドラッグ&ドロップ / `Ctrl+V` ペースト)、出力 2 経路 (「保存」= 合成画像 PNG ダウンロード /「コピー」= `navigator.clipboard` へ `image/png` 書き込み)。②呼び出され方 (standalone / embed) で I/O を切り替えるホストモード (`?mode=` パラメータ + iframe 自動判定、`data-standalone-only` 要素を CSS で非表示化) — SD Web UI からの埋め込みでは開く/保存を非表示にし、コピー・ペースト・postMessage 連携に専念できる。③ドキュメントサイズを可変化 (`doc.width/height`) し、読み込み画像の実寸に追従 (選択・履歴・フィルターは読み込み時にリセット)。検証は `npm run test:imageio` (puppeteer-core + 実機 Chrome/Edge のヘッドレス E2E、19 ケース合格) + typecheck + build + `npm run test:puppet` (22 合格)。docs 更新 (ui.md 2.6 / architecture.md) |
| 14 | **レイヤーモデルの統一 (Photoshop / Affinity Photo ライク化)** — ①元画像を「背景 (ロック付き base)」から**編集可能な image レイヤー**に変更し、起動 / 読み込み時は image レイヤー 1 枚のみで開始 (描画レイヤーはユーザーが追加)。②レイヤー操作に**ロック**を追加 (ロック中は描画・フィルター・編集対象から自動除外)。③**レイヤー指向のコピーペースト**を追加 (`core/clipboard.ts`): `Ctrl+C`/`Ctrl+X` で編集対象レイヤーの選択範囲 (選択なし = レイヤー全体) を内部クリップボードへ、`Ctrl+V` で元位置の新規レイヤーに貼り付け。外部画像の `Ctrl+V` も新規レイヤー貼り付けに変更し、ドキュメント差し替えは `Ctrl+Shift+V` / 「開く」/ ドロップに分離。④「クリップボードから新規作成」ボタン (`#btn-paste`) を追加。⑤フィルターの適用先を背景固定から**編集対象レイヤー**に変更 (`filterEngine.layerPreview` プレビュー + ベイク)。⑥「キャンセル」で読み込み直後の初期状態へ復元 (`doc.resetToInitial`)。マスク生成は paint レイヤー + 選択範囲のみ (SD Web UI 連携プロトコル維持)。検証: `npm run test:imageio` 23 ケース合格 (Ctrl+V レイヤー追加 / Ctrl+Shift+V 差し替え / 内部コピー貼り付け / ロック / embed で開く・保存非表示等) + typecheck + build + `npm run test:puppet` 22 合格。docs 更新 (ui.md 2.3・2.6 / architecture.md) |
| 15 | **パペットワープが 640×640 に制限される不具合を修正** — `puppet/mesh.ts` の `regionBounds` / `buildMesh` / `addPoint` に固定 `DOC_W`/`DOC_H` (=640) の残存があり、640px を超えるドキュメントでメッシュが 640×640 範囲に制限され、変形プレビュー / 確定時にメッシュ外のピクセルが消えて「画像が 640×640 に変化した」ように見える不具合。`buildMesh` / `regionBounds` に走査範囲 (width / height) 引数を追加し、`warpSession.createMesh` から `doc.width` / `doc.height` を渡すよう修正。単体検証に 640 超領域の回帰テスト 3 件を追加 (`npm run test:puppet` 25 合格)。E2E にも「1024×768 ドキュメントでピン追加 → ドラッグ変形 → 確定までドキュメントサイズ不変・画像全域が維持される」検証を追加 (`npm run test:imageio` 27 合格)。docs 更新 (architecture.md) |
| 16 | **フィルターペンのフィルター設定をフィルタータブからツールタブへ移動し独立化** — 従来はフィルターペンがフィルタータブ (FilterEngine) の状態を共用していたため、「ペンだけ使いたいのにフィルターを ON にした瞬間に画像全体へプレビューがかかる / 確定 (ベイク)・リセットと干渉する」問題があった。① `FilterEngine` からパラメータ保持 + 効果生成 (CSS filter 文字列 / ノイズ) を `FilterSettings` 基底クラスとして分離し、フィルターペン専用インスタンス `filterPenFx` を追加 (効果生成ロジックは一元化)。② ツールタブに「フィルター効果」セクション (`data-fx-scope="pen"`・フィルターペン選択時のみ表示) を追加し、フィルタータブ側は `data-fx-scope="image"` に分離。③ フィルター UI は `data-fx-scope` コンテナ単位で bind/sync する共通実装 (`filtersPanel.ts` の `bindFxScope` / `syncFxScope`) に一般化し二重実装を回避。④ ドキュメント差し替え時はペン設定を保持 (ツールオプション扱い) しつつ、実寸依存のノイズキャッシュのみ `filterPenFx.onDocResized()` で無効化。⑤ ペン設定無効時のトーストを「先にツールタブで有効化」案内に更新し、フィルタータブの説明文言 (適用先 = 編集対象レイヤー・ペンと独立) を整理。検証: 新規 `npm run test:filterpen` (puppeteer-core + 実機 Chrome ヘッドレス E2E、10 ケース合格 — 専用設定の表示 / フィルタータブとの独立性 / ペン有効化で画像全体が変わらないこと / なぞった範囲のみ焼き込み / 全体フィルターの従来動作 (プレビュー・非破壊) / 案内トースト) + `npm run test:imageio` 27 合格 + `npm run test:puppet` 25 合格 + typecheck + build。docs 更新 (ui.md 2.2・2.3 / architecture.md / PROGRESS.md) |
| 17 | **ツール設定パネルの表示切替 (data-show) が効かない不具合を修正** — `is-hidden` クラスの CSS が `.ctrl.is-hidden` / `.empty-note.is-hidden` のクラス限定セレクタのみで、`fx-desc` (ツール別の説明文) など `class="ctrl"` を持たない `data-show` 要素は `is-hidden` が付与されても非表示にならず、**塗りつぶし等を選択中でも他ツール用の説明文が常に表示される**既存不具合があった (フィルターペンの「フィルター効果」セクション追加時に発覚)。CSS を汎用の `.is-hidden { display: none }` に一本化して修正。E2E も classList 確認から `getComputedStyle` による実際の非表示 (display: none) 確認に強化し、fx-desc の非表示検証を追加 (`npm run test:filterpen` 12 合格) |
| 18 | **表示切替の上書き不具合 (確定/取消等が全ツールで表示される) と起動直後の選択不具合を修正** — ① 17 の汎用化だけでは `.btn { display: inline-flex }` 等 (style.css の後続行・同詳細度) が CSS カスケードで上書き勝ちし、パペットワープの「確定/取消」・選択系の「塗りつぶし/解除」ボタンが**全ツール選択中で表示される**状態だったため `.is-hidden { display: none !important }` に修正。② 起動時の `doc.init()` が `selection.resizeTo()` を呼んでおらず選択マスクが 1×1px のままになり、**起動直後 (デモ画像) で選択すると Marching Ants の点線が表示されず・範囲限定も効かない**不具合を修正 (`startApp` で `selection.resizeTo(doc.width, doc.height)` を呼び出し。「開く/ドロップ」経路では applyBaseImage が呼ぶため既存 E2E では未検出だった)。E2E (`npm run test:filterpen` 18 ケース) に「矩形選択で Marching Ants (点線) が表示される」「brush/bucket/filter-pen/select-rect/puppet-warp の各選択時に無関係なボタン (確定/取消/塗りつぶし/解除) が表示されない」検証を追加 |
| 19 | **フィルターのスライダー操作でスイッチを自動 ON** — 「スライダーをいじってからスイッチを ON にする手間」の解消。`filtersPanel.ts` の共通実装 (`bindFxScope`) で、スライダー (`input[data-fx-range]`) の操作を有効化の意思表示として扱い `settings.on[key] = true` に自動設定する (ノイズの種類カラー/グレーボタンも `on.noise = true` で自動 ON)。共通実装のため**ツールタブ (フィルター効果) / フィルタータブ両方**に一度で反映。E2E に「ペン用 / フィルタータブのスライダー操作でスイッチが自動 ON」「ノイズの種類ボタンでも自動 ON」検証を追加 (`npm run test:filterpen` 21 合格) |
| 20 | **親アプリ (Forge 拡張) 連携の本実装: `JSPAINT_LOAD` 受信 + Inpainting マスクレイヤー指定** — ① `ui/hostBridge.ts` を新設し、embed 時に親から `postMessage({ type: "JSPAINT_LOAD", image, mask?, name? })` を受けてドキュメントを差し替える (README の連携仕様に準拠)。② `mask` (黒=描画なし / 白=描画あり) は白の輝度を不透明度に変換した「Inpaintマスク」レイヤーとして追加し、新設の **Inpainting マスクレイヤー指定** (`documentStore.inpaintMaskLayerId`・最大 1 枚 / レイヤーパネルの杖ボタンで付け替え・緑バッジ表示・`is-mask` 行強調) に自動設定。③ エクスポートのマスク生成 (`exportModal.buildMaskUrl`) は指定レイヤーがある場合 **そのレイヤーのみ**から (選択範囲は含めない) とし、未指定時は従来どおり全ペイントレイヤー + 選択範囲。④ **compositeImage からマスクレイヤーを除外** (`compositeCanvas` — 出力画像にマスクを焼き込まず、マスクは maskImage として別送出。canvas 表示 / バケツ塗り / スポイトの基準には影響なし)。⑤ embed で「親アプリへ送信」成功後、送信済み表示を一瞬見せて Export モーダルを自動で閉じ、描画画面へ戻る (Forge 側の iframe 再利用時に Export 画面が残らない)。⑥ ホストからのマスクレイヤーは `addImageLayer` の新オプション `{ active: false }` で**カレントにしない** (元画像を `selectLayer` でカレントにし、開いた直後から画像を編集できる)。検証: 新規 `npm run test:hostbridge` (親ページ + iframe embed の postMessage 往復 E2E、12 ケース合格 — ドキュメント差し替え / マスクレイヤー追加・自動指定 / カレントは元画像 / ボタントグル / JSPAINT_EXPORT 往復 / compositeImage へのマスク非混入 / maskImage ピクセル検証) + `npm run test:imageio` 27 合格 + typecheck + build。docs 更新 (README 親アプリ連携セクション) |
| 21 | **Inpainting マスクレイヤーのドット網掛表示 (SD WebUI Forge 風)** — マスク指定レイヤーのキャンバス表示を、Forge の Inpaint マスク (high contrast: `modules_forge/forge_canvas/canvas.js` の `contrast_scribbles` = 10px 白黒チェッカーパターン × 描画キャンバス opacity 0.5) と同じ「透過ドット網掛」に変更。① 新設 `rendering/maskDisplay.ts` — レイヤーのアルファでチェッカーパターンを切り抜き (`destination-in`) 50% 不透明度で合成する表示専用変換で、レイヤーの実データ (色・アルファ)・エクスポートされるマスク画像には無影響。どんな色で描いても表示はドットに統一される。② `renderer.ts` のレイヤーループでマスク指定レイヤーのみ `drawMaskLayerDisplay` 経由に差し替え (フィルター / パペットワープのプレビュー canvas があればそれをソースに使用)。③ 過剰変換の副作用修正: `setInpaintMaskLayer` が `hooks.render()` を呼んでおらずマスク指定を切り替えてもキャンバスが再描画されない潜在不具合を修正 (以前は表示がマスク指定に依存しなかったため顕在化しなかった)。検証: 新規 `npm run test:maskdisplay` (puppeteer-core E2E、9 ケース合格 — view 中央行の画素走査で 網掛の表示/マスク領域限定/解除で復帰/透明部分への描画でドット追加/描画色が露出しないことを検証) + 既存 4 テスト (hostbridge 12 / imageio 27 / filterpen 21 / puppet 25) 全合格 + typecheck + build。docs 更新 (ui.md 2.3 / README / PROGRESS.md) |
| 22 | **マスクレイヤーのサムネイルもドット網掛に統一** — レイヤーパネルのサムネイルを、Inpainting マスク指定レイヤーのみ `rendering/maskDisplay.ts` の新関数 `drawMaskLayerThumb()` (レイヤーをサムネイル解像度へ縮小 → アルファでチェッカーを切り抜き) 経由で生成するよう変更。キャンバス表示と同じ白黒チェッカーだが、縮小サムネイルでもドットが読めるようマスは小さめ (6px / キャンバス表示は 10px)、下地画像が無いサムネイルでは 50% 不透明度にせず不透明で描画 (他レイヤーサムネイルと同じ明るさ)。`composeChecker()` にチェッカー合成を一般化し、タイルはマスサイズごとにキャッシュ。サムネイルの更新タイミングは従来どおり (レイヤー操作・Undo 等の `renderLayers()` 実行時。描画ストローク中は更新されない — 全レイヤー共通の既存挙動)。検証: `npm run test:maskdisplay` にサムネイル検証 4 ケースを追加 (13 ケース合格 — サムネイルの白黒タイル存在 / 描画色非露出 / 透明部分への描画の反映 / マスク以外はドット化しない) + 既存 4 テスト (hostbridge 12 / imageio 27 / filterpen 21 / puppet 25) 全合格 + typecheck + build。docs 更新 (ui.md 2.3 / README / PROGRESS.md) |
| 23 | **ブラシサイズ上限を 500px へ拡張し、ツール別サイズ保存を実装** — ①サイズスライダー / `[` `]` キー / クイックサイズの上限を 200px → 500px に拡張 (`core/editorState.ts` の `MAX_BRUSH_SIZE` に一元化、スライダーの max は `syncSlider()` で常に定数と同期)。②サイズをツールごとに独立して記憶し、切替時にそのツールの値へ復元 (`setBrushSize()` がすべての入口で記憶、`restoreToolSize()` を `setTool()` から呼び出し。対象は `SIZE_TOOLS` = サイズUIを持つ 11 ツール)。③localStorage (`jspaint.toolSizes.v1`) で永続化し、再読込後も復元 (起動時に `loadToolSizes()`、壊れたデータは無視して既定値起動)。サイズUIを持たないツール (塗りつぶし / 魔法の杖 / 選択系等) ではサイズ行自体が非表示のため混乱なし。不透明度 (強さ) は従来どおり全ツール共用。検証: 新規 `npm run test:toolsize` (puppeteer-core E2E、22 ケース合格 — スライダー上限同期 / 300px 設定 / `]` キーの 500px クランプ / ツール別記憶・復元 / リロード復元 / クイックサイズ / 壊れたデータ耐性) + 既存 5 テスト (filterpen 21 / imageio 27 / puppet 25 / maskdisplay 13 / hostbridge 12) 全合格 + typecheck + build。docs 更新 (ui.md 2.2 / 2.3 / 本書) |
| 24 | **パペットワープのプレビューを高速化** — ドラッグ中の重さ (pointermove 毎に全三角形のクリップ + フルサイズ転写が同期的に走る) を 3 つの低リスク改善で軽減。① `moveDragPin` のプレビュー更新を `requestAnimationFrame` で **1 フレーム 1 回へ間引き**、ドラッグ中は `imageSmoothingQuality = "low"` で転写 (ピンを離した時 / 確定時に `high` で仕上げ直すため確定画質は不変、`endDrag` / `commit` / `resetTo` / `dispose` で保留中の更新をキャンセル)。② 三角形ごとの `drawImage` を**変形先外接矩形を逆アフィン変換したソース領域に限定** (`warpPaint.ts` に `inverseTransformRect` を追加、±1px のサンプリング余白つきでソース範囲へクランプ)。③ **ピン未移動 (恒等変形) のうちはメッシュ転写をスキップ**し元画像をそのままプレビューに使用 (ピン追加・削除・メッシュ再生成時の負荷軽減)。検証: typecheck + build + `npm run test:puppet` (25 合格)。docs 更新 (ui.md 2.4.1 / 本書) |
| 25 | **シャープフィルターを追加** — フィルタータブ (全体フィルター) とフィルターペン (ツールタブの「フィルター効果」) の両方に「シャープ」(0〜100%) を追加。CSS filter にシャープは存在しないため `FilterSettings.applySharpen()` を新設し、**アンシャープマスク** (出力 = 元画像 + 強度 × (元画像 − blur(1px) 参照)) を自前実装 — ぼかし参照は GPU 高速な CSS blur を利用し、premultiply 空間で計算して半透明エッジの色ズレを回避、アルファは不変。`layerPreview` / `bake` / フィルターペン (bbox 切り抜き canvas へ事前適用 — ストローク中の処理をブラシ周辺の小領域に限定) はシャープ済み canvas をソースとして使用し、UI は既存の data-fx-* 共通機構で両スコープへ追加 (`FX_FORMAT` への 1 行のみ・二重実装なし)。検証: `npm run test:filterpen` にシャープ 8 ケースを追加 (29 合格 — 両スコープの UI 存在 / ペンの範囲焼き込み・範囲限定 / 全体プレビュー・非破壊 / ベイク・設定リセット) + 既存 5 テスト (toolsize 22 / maskdisplay 13 / puppet 25 / imageio 27 / hostbridge 12) 全合格 + typecheck + build。docs 更新 (ui.md 2.3 / architecture.md / README / 本書) |
| 26 | **シャープフィルターの効果を強化** — 「あまりシャープにならない」不満への対応。原因は CSS `blur(1px)` が σ≈0.5px の非常に弱いぼかしのためアンシャープマスクの差分 (元画像 − ぼかし参照) が小さく、amount 1.0 でも効果が控えめだったこと。① 強度 100% での amount を 1.0 → **2.0** へ。② ぼかし参照半径を固定 1px → **強度に比例して 1〜2.5px** へ (低強度 = ほんのり細かく / 高強度 = はっきり大胆に、スライダー全域が有効に機能)。③ フィルターペンの bbox 余白へ参照半径上限 (`FilterSettings.SHARPEN_RADIUS_MAX` を public 化) を加算し参照切れを防止。E2E に「強度を下げると効果も弱まる」ケースを追加し、効果の実測値 (エッジ変化量: 100% = 71 / 20% = 21、強化前 100% は 8〜20 程度) をテストログへ出力。検証: typecheck + build + `npm run test:filterpen` 30 合格。docs 更新 (ui.md 2.3 / 本書) |
| 27 | **ツール選択時の「ツール」タブ自動切替** — 右パネル (Properties) のタブを、ツールを選択したタイミングで自動的に「ツール」タブへ切り替える機能を追加。フィルター / レイヤータブ表示中にツールを選ぶ (ツールボタン click / ショートカットキー / 階層スタック) と選択したツールの設定が即座に表示される。タブ切替ロジックを `ui/panels.ts` の新関数 `activateTab()` に共通化し、`setTool()` から `activateTab("tool")` を呼ぶ形に統一 (タブの手動クリックも同じ関数経由・二重実装なし)。ツールタブ表示中の切替では変化なし (冪等)。検証: 新規 `npm run test:tooltab` (puppeteer-core E2E、15 ケース合格 — 初期状態 / キーボード・ボタン両入口の自動復帰 / 同一ツール再選択でも復帰 / ツールタブ中の切替でタブ維持 / 手動切替は従来どおり) + 既存 6 テスト (toolsize 22 / filterpen 30 / puppet 25 / maskdisplay 13 / imageio 27 / hostbridge 12) 全合格 + typecheck + build。docs 更新 (ui.md 2.3 / 本書) |
| 28 | **「クリップボードから新規画像」ボタンを追加** — ヘッダーのペーストボタン (`#btn-paste` = 新規レイヤー貼り付け) の隣に、OS クリップボードの画像で**新規ドキュメントを作成**するボタン (`#btn-paste-new`, `image-plus` アイコン) を追加。`Ctrl+Shift+V` 相当 (ドキュメント差し替え・実寸追従・選択/履歴/フィルターリセット) をショートカットなしで実行できる。`ui/imageIO.ts` の OS クリップボード読み取りを「新規レイヤー / 新規ドキュメント」切替式の共通関数 `pasteFromOsClipboard(asDocument)` に一元化。ボタンは両モード (standalone / embed) で表示 (`Ctrl+Shift+V` が embed でも動作するため)。旧ペーストボタンの title 表記から「Ctrl+Shift+V で新規ドキュメント」を分離し、新ボタンへ案内。検証: `npm run test:imageio` に `navigator.clipboard.read` スタブを追加し 4 ケース拡張 (31 合格 — ボタンで新規ドキュメント作成 / clipboard.png 名 / レイヤー1枚 / 画像なし時の案内トースト + standalone・embed でのボタン表示) + typecheck + build。docs 更新 (ui.md 2.1・2.6.2 / 本書) |
| 29 | **直線・矩形・円をツールスタック (階層ボタン) に集約** — ツール数増加に伴い、図形 3 ツール (直線 / 矩形 / 円) を覆い焼き / 焼き込みと同じ `.toolstack` (階層ボタン) 1 枠にまとめた。メインボタンは選択中ツールのアイコン / title に追従 (`syncToolStackDisplay` — 既存の汎用機構をそのまま利用し **JS 側の変更はなし**・グループ定義は index.html の `data-stack="line,rect,ellipse"` のみ)、▶ キャレット / メイン右クリックでメンバー一覧ポップを開閉、外側クリックで閉じる。ショートカット `L` / `U` / `O` は従来どおり有効で、切替時にメイン表示が追従する。サイズ行 (SIZE_TOOLS) 対象も従来どおり。検証: 新規 `npm run test:toolstack` (puppeteer-core E2E、19 ケース合格 — スタック存在 / 初期状態 / ポップ開閉 / ポップ選択・ショートカット切替とメイン追従 / 右クリック / 外側クリック / サイズ行表示 / 覆い焼き・焼き込みスタックの回帰) + 既存 7 テスト (toolsize 22 / tooltab 15 / filterpen 30 / imageio 31 / maskdisplay 13 / hostbridge 12 / puppet 25) 全合格 + typecheck + build。docs 更新 (ui.md 2.2 / README / 本書) |
| 30 | **AI被写体選択 (`A`) を追加 — U-2-Net による自動範囲選択** — Affinity Photo の「被写体を選択」相当。クリックした位置を含む被写体を saliency map から自動抽出する。① **新設 `src/ai/`** — `ortRuntime.ts` (onnxruntime-web 1.30 の「wasm 外部渡し」ビルドを `#ort-module` エイリアスで解決し、ランタイム wasm 13.6MB + ローダー mjs を `?url` data URI で同梱 → 実行時に Blob URL 化して `wasmPaths` へ渡す。bundle 版は `new URL(...)` が Vite で多重インライン化され約3倍に膨張するため回避)、`modelStore.ts` (IndexedDB `jspaint.ai` にモデルをキャッシュ / 不可環境はメモリフォールバック)、`subjectMask.ts` (min-max 正規化 / しきい値化 / 4近傍連結成分ラベリングの pure 関数群)、`u2netSegmenter.ts` (320×320 推論 / 入出力名はセッションから動的取得)、`aiSelectController.ts` (モデルの warmup / 読込 / 削除、saliency キャッシュ = ドキュメントサイズ + `historyStack.revision`、成分選択→`applySelection` 統合)。② **モデルは同梱しない** — 初回クリックで `.onnx` 選択ダイアログ (rembg 配布の u2net.onnx 約168MB / Apache-2.0) → IndexedDB にキャッシュして次回から自動起動 (file:// でも永続化を E2E で実証)。③ **UI** — ツールボックスに追加 (アイコン scan-search) / ツールタブに検出しきい値 (5〜95% 既定50) とモデル管理 (状態表示・読み込む・削除) / 選択合成モード (新規/追加/除外) は既存機構に接続 / 推論中はカーソル wait。④ **検証** — 新規 `npm run test:aisubject` (Part 1: subjectMask 純関数の node 単体テスト / Part 2: スタブ ONNX — `make-stub-model.mjs` が protobuf を直書き生成する「チャンネル平均=saliency」最小モデル 145B、`ints` 属性は proto2 非packed で書く必要あり — による E2E。合計 19 ケース合格: 単一HTMLの単一性 / ステータス遷移 / 選択・追加・除外・しきい値 / **リロード後の IndexedDB 永続化** / モデル削除)。⑤ dist は **19.5MB の単一HTML** のまま (起動時間は従来どおり、ort は初回利用時まで読み込まない)。docs 更新 (ai-subject-select.md 新設 / ui.md 2.2・2.3・2.4・3 / architecture.md / README / 本書) |
| 31 | **AIモデルのダウンロード元案内を追加 + 推論前処理を修正 (v0.2.17)** — ① **セットアップモーダル** (`#modal-ai-model`): モデル未読み込みの状態で AI ツールをクリックすると「AIモデルのセットアップ」モーダルが開き、**ダウンロード元リンク** (GitHub 公式 `danielgatis/rembg` リリース = rembg 本体が使用する URL (MD5 付き) / Hugging Face ミラー `tomjackson2023/rembg` — 実在を確認済み) と手順を表示。「モデルを読み込む…」でファイル選択へ進む。ツールタブの「ダウンロード元…」ボタンからも再表示可 (Esc / 閉じる / 背景クリックで閉じる)。リンクデータは新設 `src/ai/modelSources.ts` に一元化 (`ui/panels.ts` の `renderAiSources` が描画)。② **推論前処理を rembg / U-2-Net 本家と統一** — 従来の `/255` のみから、**ImageNet の mean/std 正規化** (`(x/255 − mean) / std`、mean=(0.485,0.456,0.406) / std=(0.229,0.224,0.225)) を適用するよう修正 (rembg の `sessions/u2net.py` 参照時に判明。実モデルでの選択精度が向上する)。③ 検証: `npm run test:aisubject` にモーダルの表示 / リンク 2 件 (GitHub / HuggingFace) / Esc・閉じるでの開閉を追加し **23 ケース合格** + typecheck + build。docs 更新 (ai-subject-select.md 6.1 / ui.md 2.3 / 本書) |
| 32 | **AI被写体選択を SlimSAM (対話セグメンテーション) へ全面置き換え (v0.2.18)** — U-2-Net の saliency 方式は「クリックが検出に関与しない」「複数オブジェクトの選別が苦手」という構造的限界があったため、**プロンプト可能な SAM 方式 (SlimSAM-77-uniform 変換版 / Apache-2.0)** へ置き換えた。① **モデル** — `vision_encoder.onnx` (23MB) + `prompt_encoder_mask_decoder.onnx` (17MB) の2ファイル (Xenova 版 ONNX / 入出力仕様は実機で確認: encoder `pixel_values[1,3,1024,1024]` → embeddings `[1,256,64,64]` ×2、decoder `input_points[1,1,N,2]`+`input_labels[1,1,N]` int64 → `iou_scores[1,1,3]`+`pred_masks[1,1,3,256,256]`)。前処理は SAM 標準の 1024×1024 + `(x/255−0.5)/0.5`。IoU 最大のマスク候補を採用し `logits > 0` で確定。② **UX (Affinity 風)** — クリック = 対象ポイント追加 → マスク即時更新 / **ドラッグ = 囲んで選択** (Xenova 版 ONNX に box 入力がないため コーナー2点+中心の3ポイント近似) / Alt+クリック = 除外ポイント / Enter = 確定 / Esc = ポイントクリア (選択範囲維持) / ツール離脱・ドキュメント変更でもクリア。画像埋め込みはドキュメント変更時のみ再計算 (ポイント反復はデコーダのみ = 高速)。③ **モデル管理** — 読み込みは複数選択可 (ファイル名でエンコーダ/デコーダに自動振り分け) / IndexedDB 2キー (`slimsam-encoder` / `slimsam-decoder`) / 状態表示に部分読み込みを追加。④ **実装** — `src/ai/` を `samSegmenter.ts` (2セッション) + `samController.ts` (ポイント制御・埋め込みキャッシュ) + `modelSources.ts` に再編し `u2netSegmenter.ts` / `subjectMask.ts` / `aiSelectController.ts` を削除。⑤ **検証** — スタブ生成を Python + onnx に移行 (`scripts/make_stub_sam.py` — ONNX チェッカ合格の SlimSAM 互換ミニモデル ×2。JS 直書き protobuf は repeated フィールドのエンコードミスが原因で不採用)。`npm run test:aisubject` を SAM フロー向けに書き直し **11 ケース合格** (単一HTML単一性 / モーダル / ポイント選択・塗り検証 / Esc・Enter / ドラッグ囲み / IndexedDB 永続化 / 削除)。実モデルの推論経路は `scripts/check-slimsam.cjs` で検証 (クリック位置に応じた対象選択・陰性ポイントを確認)。⑥ 既存 8 テスト全合格 + typecheck + build (dist 19.5MB 単一HTML)。docs 更新 (ai-subject-select.md 全面改訂 / ui.md / architecture.md / README / 本書) |
| 33 | **SlimSAM の前処理を SAM 正式仕様に修正し 検出精度を改善 (v0.2.19)** — 実機で「オブジェクトを検出できない」不満への対応。preprocessor_config.json (Xenova/slimsam-77-uniform) を確認したところ、実装の前処理に2つの誤り: ① **正規化**を `(x/255 − 0.5) / 0.5` から **ImageNet の mean/std** `(x/255 − [0.485,0.456,0.406]) / [0.229,0.224,0.225]` に修正。② **リサイズ**を 1024×1024 への強制スケール (アスペクト無視) から **最長辺 1024 リサイズ (アスペクト維持) + 1024×1024 ゼロパディング (正規化後の配列を 0 で埋める)** に修正。合わせて デコーダ出力 logits をパディング領域を除いた**有効グリッド (rw/4 × rh/4) にクロップ**してからドキュメント解像度へ拡大 (パディング部の logits は無意味)。ポイント座標は `docX × scale` (scale = 1024/最長辺 / `SamEmbeddings` に scale/rw/rh を保持)。検証: `scripts/check-slimsam.cjs` (合成画像で4方式の maskIoU 比較ユーティリティ) を整備 / `npm run test:aisubject` 12 ケース合格 + typecheck + build。docs 更新 (ai-subject-select.md 2・5 / 本書) |
| 34 | **マスク候補切替 / 高精度モデル案内 / ドラッグ囲み選択を追加 (v0.2.20)** — 「上手くいく/いかない」の揺れへの対策。① **マスク候補切替** — SAM は 1 クリックで 3 種のマスク候補 (IoU 降順ではない) を返すため、従来は IoU 最大の1つだけを自動適用しており「外れた候補しかない」ケースがあった。デコーダ出力を 3 候補すべて保持するよう拡張 (`SamSegmenter.decode` → `SamLogits.candidates`) し、ツールタブに**候補 1〜3 ボタン (IoU 併記)** / `Tab` キーで循環切替を追加 (`samController.setCandidate` / `cycleCandidate`)。② **高精度モデル案内** — セットアップモーダルに **SAM ViT-B 量子化版** (vision_encoder_quantized 101MB + 同一仕様デコーダ 17MB / Xenova/sam-vit-base) のリンク群を追加 (`AI_MODEL_SOURCES_HQ`)。入出力仕様は SlimSAM 版と同一のためアプリは無変更で動作し、モデル容量に応じた精度の選択が可能に。③ **ドラッグ囲み選択** — ドラッグ範囲のコーナー2点+中心を3ポイントとして渡す近似実装 (Xenova 版 ONNX は box 非対応のため) / ドラッグ中は緑破線プレビュー / 移動量 4px 未満はクリック扱い。④ **検証** — `npm run test:aisubject` に候補切替・ドラッグ囲みの検証を追加し **13 ケース合格** + 既存 8 テスト全合格 + typecheck + build。docs 更新 (ai-subject-select.md 1・6・8 / ui.md 2.3 / 本書) |

## 次回候補 (Backlog)

- パペットワープのさらなる高速化: メッシュ生成の `contains` を Uint8Array マスク化 (全ピクセル走査の関数呼び出し排除) / MLS 重みのキャッシュ (ピン追加・削除時のみ再計算) / 選択範囲ありの中間合成をマスク不透明領域に限定 / Delaunay 境界エッジ抽出のハッシュ化 / WebGL による三角形ラスタライズ (大掛かり)
- 選択範囲の移動 / 変形 (移動ツール)
- レイヤー順序入替・ブレンドモード・不透明度
- Marching Ants を輪郭トレース (閉ループパス化) に置換 (現状は境界ピクセル近似)
- マスクの羽化 (feather) / ブラシのエッジ軟化
- Inpainting マスクレイヤーの複数指定 (現在は 1 枚のみ)
- 親アプリ連携の拡張: 完了時のドキュメントリセット方針 / 複数レイヤーの受け渡しプロトコル
- 読み込み画像の拡大/縮小・リサイズ UI (現在は実寸のまま読み込む)
- **AI被写体選択の精度改善 (最優先・v0.2.20 運用評価より「両SAMモデル (SlimSAM / SAM ViT-B 量子化) とも検出精度が実用に一歩及かない」)**:
  - 高精度モデルへの対応: SAM2 系 (sam2.1-hiera-tiny/small 等) の ONNX 変換と読み込み /
    SAM ViT-B fp32 非量子化 (359MB・量子化版より高精度) / SAM ViT-L — いずれも自前変換 (torch → optimum) か
    コミュニティ配布の調査が必要
  - **box プロンプトの正式対応**: optimum による box 対応デコーダの自前エクスポート
    (現在は Xenova 版に box 入力がないため コーナー2点+中心の3ポイント近似)
  - **mask_input による反復改善**: 前回 logits を mask_input/has_mask_input でフィードバックし
    ポイント追加ごとにマスクを単調改善する (Xenova 版デコーダは mask_input 未対応 → 自前エクスポートが必要)
  - **マスク後処理の強化**: モルフォロジー演算 (小島除去・穴埋め) / 境界フェザー /
    選択境界の滑らか化 (現在は logits>0 の二値化 + 単純拡大のみ)
  - **推論基盤**: WebGPU EP 対応 (エンコード高速化) / Web Worker 移行 (推論中の UI ブロック除去)
  - UI 改善: 3 候補の色分けオーバーレイ表示 / ポイントの可視化と個別削除
