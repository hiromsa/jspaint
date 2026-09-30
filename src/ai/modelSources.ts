/**
 * ai/modelSources.ts — AIモデル (u2net.onnx) のダウンロード元情報
 *
 * URL は rembg 本体が使用している配布先 (sessions/u2net.py の pooch.retrieve) と、
 * 実在を確認済みの Hugging Face ミラー。UI (セットアップモーダル) とテストの両方から参照する。
 */

export interface AiModelSource {
  /** 種別バッジのテキスト (公式 / ミラー) */
  tag: string;
  /** バッジの CSS クラス (tag--blue / tag--white) */
  tagClass: string;
  /** 表示名 */
  label: string;
  /** ダウンロードURL */
  url: string;
  /** 補足 (サイズ / MD5 など) */
  note: string;
}

/** U-2-Net モデルのダウンロード元 (公式 → ミラーの順) */
export const AI_MODEL_SOURCES: AiModelSource[] = [
  {
    tag: "公式",
    tagClass: "tag--blue",
    label: "GitHub — rembg リリース",
    url: "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx",
    note: "rembg 本体が使用する配布元 (MD5: 60024c5c889badc19c04ad937298a77b)",
  },
  {
    tag: "ミラー",
    tagClass: "tag--white",
    label: "Hugging Face — tomjackson2023/rembg",
    url: "https://huggingface.co/tomjackson2023/rembg/resolve/main/u2net.onnx",
    note: "u2net.onnx (176 MB) / GitHub が混み合っている場合の代替",
  },
];
