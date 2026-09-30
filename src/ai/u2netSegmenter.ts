/**
 * ai/u2netSegmenter.ts — U-2-Net (Salient Object Detection) 推論
 *
 * 入力: 合成画像を 320x320 へリサイズし RGB / 255 で正規化 (1x3x320x320)
 * 出力: d0 (saliency map, 1x1x320x320, 0..1) — U-2-Net の第一出力
 *
 * U-2-Net / u2netp ともに 320x320 固定入力が学習条件のため、ここでは定数を使用する
 * (入出力名はセッションから取得するため、rembg 互換の変換モデル全般で動作する)。
 */
import { createCanvas } from "../core/canvasUtils";
import type { InferenceSession } from "onnxruntime-web/wasm";
import { loadOrt } from "./ortRuntime";

/** モデル入力の1辺 (U-2-Net 学習時の仕様) */
export const SEG_INPUT_SIZE = 320;

/** 推論結果の saliency map (0..1 の生の値) */
export interface SaliencyMap {
  width: number;
  height: number;
  data: Float32Array;
}

/** ort セッションを包んだ推論器 (UI に依存しない) */
export class U2NetSegmenter {
  private constructor(private readonly session: InferenceSession) {}

  /** モデルバイト列から推論器を生成する (ort 初期化 + セッション構築を含む) */
  static async create(modelBytes: Uint8Array): Promise<U2NetSegmenter> {
    const ort = await loadOrt();
    const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ["wasm"] });
    return new U2NetSegmenter(session);
  }

  /** 画像 (任意サイズ canvas) から saliency map を推論する */
  async infer(source: HTMLCanvasElement): Promise<SaliencyMap> {
    const ort = await loadOrt();
    const size = SEG_INPUT_SIZE;
    // 前処理: 全体を 320x320 へリサイズ (U-2-Net はアスペクト比を無視した全図入力が前提)
    const input = createCanvas(size, size);
    const g = input.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(source, 0, 0, size, size);
    const px = g.getImageData(0, 0, size, size).data;

    // NCHW (1,3,320,320) の float32 へ展開。
    // 前処理は rembg / U-2-Net 本家と同じ「/255 → ImageNet の mean/std 正規化」
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    const plane = size * size;
    const chw = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      chw[i] = (px[i * 4] / 255 - mean[0]) / std[0];
      chw[plane + i] = (px[i * 4 + 1] / 255 - mean[1]) / std[1];
      chw[plane * 2 + i] = (px[i * 4 + 2] / 255 - mean[2]) / std[2];
    }

    const inputName = this.session.inputNames[0];
    const outputName = this.session.outputNames[0];
    const tensor = new ort.Tensor("float32", chw, [1, 3, size, size]);
    const results = await this.session.run({ [inputName]: tensor });
    const out = results[outputName];
    return { width: size, height: size, data: out.data as Float32Array };
  }

  /** セッションを解放する (モデル削除 / 差し替え時) */
  async dispose(): Promise<void> {
    await this.session.release();
  }
}
