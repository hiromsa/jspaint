/* 実SlimSAMモデルの推論経路をNodeで検証する (前処理/プロンプト/後処理の設計確認) */
(async () => {
  try {
    const ort = require("onnxruntime-web");
    const fs = require("node:fs");
    const { createCanvas } = require("canvas");
    console.log("node-canvas なしでスキップ: canvas API はブラウザ専用のため、ここでは生ピクセルで代用する");
  } catch {}
  // canvas がない環境のため、生ピクセル配列で 1024×1024 のテスト画像を構成する
  const ort = require("onnxruntime-web");
  const fs = require("node:fs");
  const S = 1024;
  // 左上に 512×512 の明るい正方形、それ以外は暗い
  const lum = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) lum[y * S + x] = x < 512 && y < 512 ? 0.9 : 0.1;

  // 前処理 (アプリと同じ): NCHW, (x/255-0.5)/0.5
  const px = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) {
    const v = (lum[i] * 255 - 0.5) / 0.5;
    px[i] = v;
    px[S * S + i] = v;
    px[2 * S * S + i] = v;
  }
  const enc = await ort.InferenceSession.create(fs.readFileSync("models/slimsam/vision_encoder.onnx"));
  const dec = await ort.InferenceSession.create(fs.readFileSync("models/slimsam/prompt_encoder_mask_decoder.onnx"));
  const e1 = await enc.run({ pixel_values: new ort.Tensor("float32", px, [1, 3, S, S]) });
  console.log("embeddings:", JSON.stringify(e1.image_embeddings.dims));

  // ポイント: 明るい正方形の中心 (512/2=256,256) — 1024空間そのまま
  const runDecode = async (points) => {
    const coords = new Float32Array(points.length * 2);
    const labels = new BigInt64Array(points.length);
    points.forEach((p, i) => {
      coords[i * 2] = p.x;
      coords[i * 2 + 1] = p.y;
      labels[i] = BigInt(p.label);
    });
    const r = await dec.run({
      image_embeddings: e1.image_embeddings,
      image_positional_embeddings: e1.image_positional_embeddings,
      input_points: new ort.Tensor("float32", coords, [1, 1, points.length, 2]),
      input_labels: new ort.Tensor("int64", labels, [1, 1, points.length]),
    });
    const ious = [...r.iou_scores.data];
    let best = 0;
    for (let i = 1; i < ious.length; i++) if (ious[i] > ious[best]) best = i;
    const [, , , mh, mw] = r.pred_masks.dims;
    const raw = r.pred_masks.data;
    const logits = raw.subarray(best * mh * mw, (best + 1) * mh * mw);
    // マスク統計: 正の割合と「左上512領域内 / 外」の分布
    let inSq = 0, inSqPos = 0, outSq = 0, outSqPos = 0;
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        const v = logits[y * mw + x] > 0;
        const isIn = x < (mw * 512) / S && y < (mh * 512) / S;
        if (isIn) { inSq++; if (v) inSqPos++; } else { outSq++; if (v) outSqPos++; }
      }
    }
    return { iou: ious[best], maskSize: mh, inSq: `${inSqPos}/${inSq}`, outSq: `${outSqPos}/${outSq}` };
  };

  console.log("point(256,256)+:", JSON.stringify(await runDecode([{ x: 256, y: 256, label: 1 }])));
  console.log("point(768,768)+:", JSON.stringify(await runDecode([{ x: 768, y: 768, label: 1 }])));
  console.log("point(256,256)+ (768,768)-:", JSON.stringify(await runDecode([{ x: 256, y: 256, label: 1 }, { x: 768, y: 768, label: 0 }])));
})().catch((e) => console.error("ERR:", e.message ?? e));
