/**
 * ai/samSegmenter.ts — SlimSAM (Segment Anything Model 軽量版) の推論
 *
 * 2つの ONNX セッションを扱う:
 *   - vision_encoder:            画像 1024×1024 → 画像埋め込み (ドキュメント変更時の1回のみ)
 *   - prompt_encoder_mask_decoder: 埋め込み + ポイント → マスク logits (クリックごとに高速に再実行)
 *
 * 前処理は SAM 標準 (preprocessor_config.json 準拠):
 *   - 最長辺を 1024 にリサイズ (アスペクト比維持)
 *   - 1024×1024 へゼロパディング (正規化後の配列を 0 で埋める)
 *   - ImageNet の mean/std で正規化 ((x/255 − mean) / std)
 * ポイント座標は同じ 1024 空間へ線形変換して渡す。
 * マスクの確定は「logits > 0」(SAM の標準規則)。出力は 3 種のマスク候補のため
 * IoU スコアが最大のものを採用し、パディング領域を除いた有効領域だけを返す。
 */
import { createCanvas } from "../core/canvasUtils";
import type { InferenceSession, Tensor } from "onnxruntime-web/wasm";
import { loadOrt } from "./ortRuntime";

/** モデル入力の1辺 (SAM の標準解像度) */
export const SAM_INPUT_SIZE = 1024;

/** 陽性 / 陰性ポイント (1024 空間座標) */
export interface SamPoint {
  x: number;
  y: number;
  /** true = 対象 (陽性) / false = 除外 (陰性) */
  positive: boolean;
}

/** エンコーダ出力の埋め込み (デコーダ入力そのまま) と 座標変換情報 */
export interface SamEmbeddings {
  embeddings: Tensor;
  positional: Tensor;
  /** ドキュメント → 1024 空間のスケール係数 (最長辺を 1024 に合わせる) */
  scale: number;
  /** リサイズ後の有効領域 (1024 空間・残りはゼロパディング) */
  rw: number;
  rh: number;
}

/** デコーダ出力の logits マスク (0 以下 = 非選択 / 0 超 = 選択) */
export interface SamLogits {
  /** width × height の logits (有効領域のみにクロップ済み) */
  data: Float32Array;
  width: number;
  height: number;
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
    const scale = SAM_INPUT_SIZE / Math.max(source.width, source.height);
    const rw = Math.max(1, Math.round(source.width * scale));
    const rh = Math.max(1, Math.round(source.height * scale));
    const resized = createCanvas(rw, rh);
    const g = resized.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(source, 0, 0, rw, rh);
    const px = g.getImageData(0, 0, rw, rh).data;

    // NCHW (1,3,1024,1024)。有効領域のみ ImageNet mean/std で正規化し、パディング領域は 0 のまま
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    const chw = new Float32Array(3 * SAM_INPUT_SIZE * SAM_INPUT_SIZE); // 0 埋め
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const si = (y * rw + x) * 4;
        const di = y * SAM_INPUT_SIZE + x;
        chw[di] = (px[si] / 255 - mean[0]) / std[0];
        chw[SAM_INPUT_SIZE * SAM_INPUT_SIZE + di] = (px[si + 1] / 255 - mean[1]) / std[1];
        chw[2 * SAM_INPUT_SIZE * SAM_INPUT_SIZE + di] = (px[si + 2] / 255 - mean[2]) / std[2];
      }
    }
    const tensor = new ort.Tensor("float32", chw, [1, 3, SAM_INPUT_SIZE, SAM_INPUT_SIZE]);
    const results = await this.encoder.run({ pixel_values: tensor });
    return { embeddings: results.image_embeddings, positional: results.image_positional_embeddings, scale, rw, rh };
  }

  /**
   * ポイント (1024 空間座標) からマスク logits を推論する。
   * SAM は 3 種のマスク候補を出すため IoU スコア最大のものを採用し、
   * パディング領域を除いた有効領域 (rw/4 × rh/4) にクロップして返す。
   */
  async decode(embeddings: SamEmbeddings, points: { x: number; y: number; positive: boolean }[]): Promise<SamLogits> {
    const ort = await loadOrt();
    const n = points.length;
    if (n === 0) throw new Error("ポイントがありません");

    const coords = new Float32Array(n * 2);
    const labels = new BigInt64Array(n);
    points.forEach((p, i) => {
      coords[i * 2] = p.x;
      coords[i * 2 + 1] = p.y;
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
    const dims = masks.dims;
    const mh = dims[dims.length - 2];
    const mw = dims[dims.length - 1];
    const raw = masks.data as Float32Array;
    const base = best * mh * mw;
    // 有効領域 (リサイズ後の領域 / 4) だけをクロップ (パディング部の logits は無意味)
    const gw = Math.max(1, Math.round((embeddings.rw / SAM_INPUT_SIZE) * mw));
    const gh = Math.max(1, Math.round((embeddings.rh / SAM_INPUT_SIZE) * mh));
    const logits = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        logits[y * gw + x] = raw[base + y * mw + x];
      }
    }
    return { data: logits, width: gw, height: gh, iou: ious[best] };
  }

  /** セッションを解放する (モデル削除 / 差し替え時) */
  async dispose(): Promise<void> {
    await this.encoder.release();
    await this.decoder.release();
  }
}

