/**
 * ai/samSegmenter.ts — SlimSAM (Segment Anything Model 軽量版) の推論
 *
 * 2つの ONNX セッションを扱う:
 *   - vision_encoder:            合成画像 1024×1024 → 画像埋め込み (ドキュメント変更時の1回のみ)
 *   - prompt_encoder_mask_decoder: 埋め込み + ポイント → マスク logits (クリックごとに高速に再実行)
 *
 * 前処理: 合成画像を 1024×1024 へリサイズし (x/255 − 0.5) / 0.5 で正規化 (SAM の標準前処理)。
 * ポイント座標は同じ 1024 空間へ線形変換して渡す。マスクの確定は「logits > 0」(SAM の標準規則)。
 * 出力は SAM 特有の複数マスク (3種) のため、IoU スコアが最大のものを採用する。
 */
import { createCanvas } from "../core/canvasUtils";
import type { InferenceSession, Tensor } from "onnxruntime-web/wasm";
import { loadOrt } from "./ortRuntime";

/** モデル入力の1辺 (SAM の標準解像度) */
export const SAM_INPUT_SIZE = 1024;

/** 陽性 / 陰性ポイント */
export interface SamPoint {
  /** ドキュメント座標 */
  x: number;
  y: number;
  /** true = 対象 (陽性) / false = 除外 (陰性) */
  positive: boolean;
}

/** エンコーダ出力の埋め込み (デコーダ入力そのまま) */
export interface SamEmbeddings {
  embeddings: Tensor;
  positional: Tensor;
}

/** デコーダ出力の logits マスク (0 以下 = 非選択 / 0 超 = 選択) */
export interface SamLogits {
  /** size × size の logits */
  data: Float32Array;
  size: number;
  /** 採用したマスクの IoU スコア */
  iou: number;
}

/** ort セッション 2つを包んだ推論器 (UI に依存しない) */
export class SamSegmenter {
  private constructor(
    private readonly encoder: InferenceSession,
    private readonly decoder: InferenceSession,
  ) {}

  /** エンコーダ / デコーダのバイト列から推論器を生成する */
  static async create(encoderBytes: Uint8Array, decoderBytes: Uint8Array): Promise<SamSegmenter> {
    const ort = await loadOrt();
    const opts = { executionProviders: ["wasm"] as const };
    const encoder = await ort.InferenceSession.create(encoderBytes, opts);
    const decoder = await ort.InferenceSession.create(decoderBytes, opts);
    return new SamSegmenter(encoder, decoder);
  }

  /** 画像 (任意サイズ canvas) から埋め込みを計算する (ドキュメント変更時の1回のみ呼ぶ) */
  async encode(source: HTMLCanvasElement): Promise<SamEmbeddings> {
    const ort = await loadOrt();
    const size = SAM_INPUT_SIZE;
    const input = createCanvas(size, size);
    const g = input.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(source, 0, 0, size, size);
    const px = g.getImageData(0, 0, size, size).data;

    // NCHW (1,3,1024,1024) へ展開。正規化は SAM 標準の (x/255 − 0.5) / 0.5
    const plane = size * size;
    const chw = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      chw[i] = (px[i * 4] / 255 - 0.5) / 0.5;
      chw[plane + i] = (px[i * 4 + 1] / 255 - 0.5) / 0.5;
      chw[plane * 2 + i] = (px[i * 4 + 2] / 255 - 0.5) / 0.5;
    }
    const tensor = new ort.Tensor("float32", chw, [1, 3, size, size]);
    const results = await this.encoder.run({ pixel_values: tensor });
    return { embeddings: results.image_embeddings, positional: results.image_positional_embeddings };
  }

  /**
   * ポイント (1024 空間座標) からマスク logits を推論する。
   * SAM は 3 種のマスク候補を出すため IoU スコア最大のものを採用する。
   */
  async decode(embeddings: SamEmbeddings, points: SamPoint[], docWidth: number, docHeight: number): Promise<SamLogits> {
    const ort = await loadOrt();
    const n = points.length;
    if (n === 0) throw new Error("ポイントがありません");

    // ドキュメント座標 → 1024 空間 (エンコーダ入力と同じ線形変換)
    const coords = new Float32Array(n * 2);
    const labels = new BigInt64Array(n);
    points.forEach((p, i) => {
      coords[i * 2] = (p.x / docWidth) * SAM_INPUT_SIZE;
      coords[i * 2 + 1] = (p.y / docHeight) * SAM_INPUT_SIZE;
      labels[i] = p.positive ? 1n : 0n;
    });

    const results = await this.decoder.run({
      image_embeddings: embeddings.embeddings,
      image_positional_embeddings: embeddings.positional,
      input_points: new ort.Tensor("float32", coords, [1, 1, n, 2]),
      input_labels: new ort.Tensor("int64", labels, [1, 1, n]),
    });

    // IoU 最大のマスク候補を選ぶ
    const ious = results.iou_scores.data as Float32Array;
    let best = 0;
    for (let i = 1; i < ious.length; i++) if (ious[i] > ious[best]) best = i;

    const masks = results.pred_masks as Tensor;
    const [, , , mh, mw] = masks.dims;
    const raw = masks.data as Float32Array;
    const logits = new Float32Array(mh * mw);
    logits.set(raw.subarray(best * mh * mw, (best + 1) * mh * mw));
    return { data: logits, size: mh, iou: ious[best] };
  }

  /** セッションを解放する (モデル削除 / 差し替え時) */
  async dispose(): Promise<void> {
    await this.encoder.release();
    await this.decoder.release();
  }
}
