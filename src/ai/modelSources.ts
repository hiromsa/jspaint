/**
 * ai/modelSources.ts — AIモデル (SlimSAM ONNX ×2) のダウンロード元情報
 *
 * いずれも Hugging Face (Xenova/slimsam-77-uniform / Apache-2.0) の実ファイルで、
 * CORS 許可済み (ACAO: * / Origin echo) を確認済み — ブラウザからの直接ダウンロードも可能。
 * GitHub 経由の配布は release assets が CORS 非対応のため手動ダウンロード専用。
 */

export interface AiModelSource {
  /** 種別バッジのテキスト */
  tag: string;
  /** バッジの CSS クラス (tag--blue / tag--white) */
  tagClass: string;
  /** 表示名 */
  label: string;
  /** ダウンロードURL */
  url: string;
  /** 補足 */
  note: string;
}

/** SlimSAM モデルのダウンロード元 (エンコーダ → デコーダの順) */
export const AI_MODEL_SOURCES: AiModelSource[] = [
  {
    tag: "エンコーダ",
    tagClass: "tag--blue",
    label: "vision_encoder.onnx (23 MB)",
    url: "https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/vision_encoder.onnx",
    note: "画像 → 埋め込み。ドキュメント変更時の1回だけ実行",
  },
  {
    tag: "デコーダ",
    tagClass: "tag--white",
    label: "prompt_encoder_mask_decoder.onnx (17 MB)",
    url: "https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/prompt_encoder_mask_decoder.onnx",
    note: "ポイント → マスク。クリックごとに高速に再実行される",
  },
];

/**
 * 高精度モデルのダウンロード元 (SAM ViT-B 量子化版 — 任意・SlimSAM より検出精度が高い)。
 * 入出力仕様は SlimSAM 版と同一のため、どちらのセットでもアプリはそのまま動作する。
 */
export const AI_MODEL_SOURCES_HQ: AiModelSource[] = [
  {
    tag: "エンコーダ",
    tagClass: "tag--blue",
    label: "vision_encoder_quantized.onnx (101 MB)",
    url: "https://huggingface.co/Xenova/sam-vit-base/resolve/main/onnx/vision_encoder_quantized.onnx",
    note: "SAM ViT-B (量子化) — SlimSAM より高精度 / エンコードに時間がかかる",
  },
  {
    tag: "デコーダ",
    tagClass: "tag--white",
    label: "prompt_encoder_mask_decoder.onnx (17 MB)",
    url: "https://huggingface.co/Xenova/sam-vit-base/resolve/main/onnx/prompt_encoder_mask_decoder.onnx",
    note: "SlimSAM 版と同一仕様",
  },
];

