# AI被写体選択 (ai-select) 仕様

Affinity Photo の「オブジェクト選択」に相当する、**プロンプト可能な対話セグメンテーション**機能の仕様。
SlimSAM (Segment Anything Model 軽量版) をブラウザ内で推論し、クリックしたポイントをヒントに
対象のマスクを構築する。外部サーバ・通信は一切使用しない (完全ローカル推論)。

---

## 1. 概要

*   **ツール**: 「AI被写体選択」(`ai-select` / ショートカット `A` / アイコン: lucide `scan-search`)
*   **操作**:
    *   **ドラッグで囲む** = 範囲内のオブジェクトを自動選択 (コーナー2点 + 中心をポイントとして渡す近似)
    *   **クリック** = 対象ポイントを追加 → そのポイントを含むオブジェクトのマスクが即座に選択範囲になる
    *   **クリック追加** = ポイントを増やすほどマスクが改善される (オブジェクトの一部 → 全体)
    *   **Alt+クリック / Alt+ドラッグ** = 除外 (その領域をマスクから削る)
    *   **マスク候補切替** = SAM は 3 種のマスク候補を返すため、パネルの候補ボタン / `Tab` で切り替え可能 (IoU 併記)
    *   **Enter** = ポイント指定を確定 / **Esc** = ドラッグ中断 → ポイントをクリア (選択範囲は維持)
    *   ツールを離す / ドキュメント差し替え / 編集操作でもポイントはクリアされる (選択範囲は維持)
*   **初回セットアップ**: モデル未キャッシュ時は最初のクリックで**セットアップモーダル**
    (ダウンロード元リンク付き) が開く。読み込み済みモデルは **IndexedDB にキャッシュ** され、
    次回起動時は自動で準備される

## 2. モデル

| 項目 | 内容 |
|---|---|
| モデル | **SlimSAM-77-uniform** (Xenova/slimsam-77-uniform 変換版 / Apache-2.0) |
| 構成 | `vision_encoder.onnx` (23MB) + `prompt_encoder_mask_decoder.onnx` (17MB) の **2ファイル** |
| encoder 入力 | `pixel_values` `1×3×1024×1024` float32 — **最長辺を 1024 にリサイズ (アスペクト比維持) → 1024×1024 へゼロパディング → ImageNet の mean/std で正規化** (preprocessor_config.json 準拠) |
| encoder 出力 | `image_embeddings` / `image_positional_embeddings` (`1×256×64×64`) |
| decoder 入力 | `input_points` `1×1×N×2` (1024空間座標) / `input_labels` `1×1×N` int64 (1=陽性, 0=陰性) / 埋め込み ×2 |
| decoder 出力 | `iou_scores` `1×1×3` / `pred_masks` `1×1×3×256×256` — **IoU 最大の候補を採用** |
| マスク確定 | **logits > 0** (SAM の標準規則) → ドキュメント解像度へバイリニア拡大 → α≥128 で再二値化 |
| 実行 | onnxruntime-web (**wasm / CPU・SIMD・単スレッド**) |

*   入出力名・shape は実機で検証済み (`scripts/check-slimsam.cjs` — 実モデルでの推論経路を Node で確認するユーティリティ)
*   画像埋め込みは「ドキュメントサイズ + 編集リビジョン」をキーにキャッシュされ、
    **ポイントを動かす反復ではデコーダ (高速) のみ再実行**される。編集・Undo/Redo・画像読み込みで自動無効化
    (`historyStack.revision` は pushUndo / undo / redo / clear で進み、その際ポイント座標もクリアされる)

## 3. 配布方式 (ランタイム同梱 / モデルはユーザー読み込み)

*   **ランタイム (onnxruntime-web) は単一HTMLへ同梱** する:
    *   ort 本体は「wasm 外部渡し」ビルド (`ort.min.mjs`) を `#ort-module` エイリアスで解決
        (bundle 版は内部の `new URL(...)` が Vite により多重インライン化され約3倍に膨らむため回避)
    *   ランタイム wasm (`ort-wasm-simd-threaded.wasm` 約13.6MB) とローダー mjs は `?url` インライン
        (data URI) で同梱し、実行時に **Blob URL 化して `ort.env.wasm.wasmPaths` へ渡す**
        (file:// からの相対読み込みは CORS でブロックされるため blob: 経路が必須)
    *   `vite.config.ts` の `resolve.alias` (`#ort-wasm` / `#ort-loader` / `#ort-module`) を参照
*   **モデル (合計約40MB) は同梱しない** (HTML 約19.5MB に収めるため)。初回のみユーザーが読み込む
*   生成物は `dist/index.html` 単一ファイルのまま (モデル等の外部ファイルは不要)
*   ※ ダウンロード元について: Hugging Face は CORS 許可済み (ブラウザからの自動DLも技術的には可能) だが、
    embed 時の意図しない大容量通信を避けるため、**ユーザーがリンクから入手 → ファイル読み込み** の
    オプトイン方式を採用している。GitHub release assets は CORS 非対応 (手動DL専用)

## 4. モデルキャッシュ (`src/ai/modelStore.ts`)

| 項目 | 内容 |
|---|---|
| 保存先 | IndexedDB (`jspaint.ai` / store `models` / key `slimsam-encoder` / `slimsam-decoder`) |
| フォールバック | IndexedDB 不可・容量オーバー時はメモリ内キャッシュ (タブ終了で消失、再読み込み案内) |
| 管理UI | ツールタブの「AIモデル」ブロック: 状態表示 / 読み込む (複数選択可・ファイル名で自動振り分け) / 削除 / ダウンロード元… |
| 検証 | 拡張子 `.onnx` と最小サイズ (256B) のみ事前チェック。不正ファイルは ort 生成時の例外で案内 |

*   キャッシュ状態はツール選択時に非同期で確認され (`warmup()`)、両ファイル揃えばセッションを準備する。
    状態は「未読み込み (2ファイル) / モデル準備中… / 解析中… / 利用可能 (キャッシュ済み)」でパネルへ表示される
*   セッション生成中・推論中はカーソルが `wait` になり、ボタンが無効化される


## 5. 推論パイプライン (`src/ai/samController.ts` / `src/ai/samSegmenter.ts`)

```
[初回クリック時]
compositeCanvas (表示合成) → 最長辺を 1024 にリサイズ (アスペクト比維持) → 1024×1024 へゼロパディング
  → ImageNet の mean/std で正規化 (NCHW・パディング領域は 0)
  → vision_encoder → 画像埋め込み + 座標変換情報 (scale / 有効領域) をキャッシュ

[クリックごと]
ポイント座標を 1024 空間へ線形変換 (docX × scale, docY × scale)
  → prompt_encoder_mask_decoder (埋め込み + input_points/labels) → IoU 最大の pred_masks
  → パディング領域を除いた有効グリッド (rw/4 × rh/4) にクロップ → logits > 0 で二値化
  → ドキュメント解像度へバイリニア拡大 → α≥128 で再二値化
  → SelectionStore.applySelection (常に置き換え) → Marching Ants 反映
```

*   ポイント追加は `ensureEmbedding()` (埋め込み準備) → ポイント push → decode の順で行う。
    埋め込み準備時にドキュメント変更を検知した場合は**古いポイント座標をクリアしてから**現在のクリックを push する
    (デコードが 0 ポイントで失敗しないよう、push は常にクリア後に行う)
*   **ドラッグ (囲み選択)** は「コーナー2点 + 中心」の3ポイント近似で実装している
    (Xenova 版 ONNX には box 入力・box_embed 重みがないため。true box プロンプトは自前エクスポートで対応候補)。
    クリック (移動量 4px 未満) との判定はポインタ UP 時の移動量で行う
*   推論はメインスレッドで実行されるため、実行前に 1 フレーム待って Busy 表示 (カーソル / ステータス)
    を描画させてから block する
*   クリックがドキュメント外の場合は何もしない

## 6. UI

### 6.1 セットアップモーダル (ダウンロード元の案内)

*   モデル未読み込みの状態で AI ツールを**クリック**すると開く (ツールタブの「ダウンロード元…」ボタンでも開閉可 / `Esc`・`閉じる`・背景クリックで閉じる)
*   内容: 必要な 2 ファイルの説明 + **ダウンロード元リンク** (`src/ai/modelSources.ts` のデータから描画):

| 種別 | ファイル | URL |
|---|---|---|
| エンコーダ | `vision_encoder.onnx` (23MB) | `https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/vision_encoder.onnx` |
| デコーダ | `prompt_encoder_mask_decoder.onnx` (17MB) | `https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/prompt_encoder_mask_decoder.onnx` |

*   「モデルを読み込む…」ボタンでファイル選択ダイアログへ進む (2つまとめて選択可・ファイル名で自動振り分け)
*   注記: ダウンロードにはインターネット接続が必要 (推論自体はブラウザ内で完結し画像は送信されない)
*   モデル一覧ページ: `https://huggingface.co/Xenova/slimsam-77-uniform`

### 6.2 ツールタブ (選択時のみ表示 / `data-show="ai-select"`)

| 要素 | 内容 |
|---|---|
| SAMポイント | 「ポイントをクリア」ボタン (クリックで指定したポイントをクリア / 選択範囲は維持) |
| AIモデル状態表示 | 「未読み込み (2ファイル) / モデル準備中… / 解析中… / 利用可能 (キャッシュ済み)」(緑強調は利用可能時) |
| 読み込む / 削除 / ダウンロード元… | `.onnx` ファイル選択ダイアログ (複数選択可) / キャッシュ削除 (両キー解放) / セットアップモーダル (6.1) を開く |
| 補足説明 | モデルの入手元 (Xenova/slimsam-77-uniform / Apache-2.0) の案内 |
| 選択合成モード | 既存の選択系と共通 (SAM 選択は常に新規置き換えだが、確定後に他ツールで追加・除外が可能) |

### 6.3 ステータスバー / トースト

*   ガイド: 「クリック = 対象を指定して自動選択 · Alt+クリック = 除外 · 追加クリックでマスクを改善 · Enter = 確定 / Esc = ポイントクリア …」
*   更新トースト: `AI選択を更新 (IoU NN% · ポイント N件)`
*   モデル読み込み成功: `AIモデルを読み込みました — 被写体をクリックして選択`

## 7. テスト (`npm run test:aisubject`)

*   スタブ ONNX (`scripts/fixtures/vision_encoder-stub.onnx` +
    `prompt_encoder_mask_decoder-stub.onnx` — `scripts/make_stub_sam.py` が生成する
    「チャンネル平均を埋め込み / logits として返す」最小モデル) を使い、
    本物のモデルなしでパイプライン全体を検証:
    *   dist が単一ファイルのこと (wasm 分離なし = file:// で動作する条件)
    *   ツール選択 / パネル表示 / ステータス遷移 / セットアップモーダル (ダウンロード元リンク・開閉)
    *   SVG テスト画像 (暗い背景 + 矩形A #eee + 矩形B #ddd) でのポイント選択:
        スタブ logits は「明るい領域ほど正」のため、クリック 1 回で A∪B が選択される (決定論的)
    *   Enter / Esc (ポイントの確定・クリアと選択範囲の維持)
    *   **IndexedDB 永続化** (リロード後の自動ウォームアップ — 2キー) とモデル削除
*   スタブ生成は Python + onnx で行う (`python scripts/make_stub_sam.py`)。
    検証スクリプトは fixtures が消失した場合に自動で再生成を試みる
*   実モデルでの推論経路確認: `node scripts/check-slimsam.cjs` (models/slimsam/ に実モデルが必要・gitignore 対象)

## 8. 制限・今後の拡張

*   **運用評価 (v0.2.20 時点)**: SlimSAM / SAM ViT-B (量子化) ともに動作するが、
    「検出精度は実用に一歩及かない」旨の評価を踏まえ、**精度改善は Backlog 最優先項目**として記録済み
    (PROGRESS.md 次回候補参照 — 高精度モデル対応 / box プロンプト / mask_input 反復 / マスク後処理 など)。
    なお本機能は Affinity の 300MB 級モデルに対し SlimSAM で 1/7 以下・ViT-B 量子化で 1/3 程度の容量であり、
    モデル容量に比例した精度差がある点に留意
*   推論はメインスレッド (Web Worker 未使用) — エンコーダはドキュメント1回のみのため実用上は問題なし
*   ドラッグ囲みは「コーナー2点 + 中心」のポイント近似 (true box プロンプト非対応 — Xenova 版 ONNX に
    box 入力 / box_embed 重みがないため)。厳密な box は自前エクスポート (optimum) で対応候補
*   前処理は正方形への単純スケール (アスペクト比を無視) — SAM 標準のパディング方式への改善候補
*   将来拡張: WebGPU EP 対応 / SAM2 系モデル / 推論の Web Worker 移行

