/**
 * scripts/check-slimsam.cjs — 実 SlimSAM モデルの推論経路検証ユーティリティ
 *
 * models/slimsam/ に実モデル 2ファイルを配置して実行:
 *   node scripts/check-slimsam.cjs
 *
 * 前処理方式 (強制スケール vs 最長辺リサイズ+ゼロパッド) と正規化 (0.5/0.5 vs ImageNet)
 * の違いがマスク品質に与える影響を、合成画像 (暗い背景 + 縦長の明るい被写体) で数値比較する。
 */
(async () => {
  const ort = require("onnxruntime-web");
  const fs = require("node:fs");
  const S = 1024; // モデル入力サイズ
  const G = 256; // pred_masks の1辺
  const W = 1024;
  const H = 640; // テスト画像 (非正方形・アスペクト 1.6)
  const BODY = { x0: 100, y0: 100, x1: 400, y1: 500 }; // 被写体 (Ground Truth)

  // テスト画像: 縦長の明るい被写体 (中心ほど明るい) + 暗いグラデーション背景
  const lum = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inBody = x >= BODY.x0 && x < BODY.x1 && y >= BODY.y0 && y < BODY.y1;
      lum[y * W + x] = inBody ? 0.75 + 0.2 * (1 - Math.abs(y - 300) / 200) : 0.15 + 0.1 * (x / W);
    }
  }

  const enc = await ort.InferenceSession.create(fs.readFileSync("models/slimsam/vision_encoder.onnx"));
  const dec = await ort.InferenceSession.create(fs.readFileSync("models/slimsam/prompt_encoder_mask_decoder.onnx"));

  /** 前処理して pixel_values を構築する (mode: squash / pad, norm: half / imagenet) */
  function buildPixelValues(mode, normMode) {
    const mean = normMode === "imagenet" ? [0.485, 0.456, 0.406] : [0.5, 0.5, 0.5];
    const std = normMode === "imagenet" ? [0.229, 0.224, 0.225] : [0.5, 0.5, 0.5];
    let scale = 1;
    let rw = S;
    let rh = S;
    if (mode === "pad") scale = S / Math.max(W, H); // 最長辺を 1024 に合わせる
    rw = Math.round(W * scale);
    rh = Math.round(H * scale);
    const chw = new Float32Array(3 * S * S); // 0 埋め = 正規化後のゼロパディング
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const sx = Math.min(W - 1, Math.floor(x / scale));
        const sy = Math.min(H - 1, Math.floor(y / scale));
        const v = to255(lum[sy * W + sx]) / 255;
        const di = y * S + x;
        chw[di] = (v - mean[0]) / std[0];
        chw[S * S + di] = (v - mean[1]) / std[1];
        chw[2 * S * S + di] = (v - mean[2]) / std[2];
      }
    }
    return { tensor: new ort.Tensor("float32", chw, [1, 3, S, S]), scale };
  }

  function to255(v) {
    return Math.round(v * 255);
  }

  /** 4方式 (前処理 × 正規化) を同一ポイントで比較する */
  const variants = [
    ["squash + 0.5/0.5 (旧実装)", "squash", "half"],
    ["pad    + 0.5/0.5", "pad", "half"],
    ["squash + ImageNet", "squash", "imagenet"],
    ["pad    + ImageNet (SAM 正式)", "pad", "imagenet"],
  ];
  for (const [label, mode, normMode] of variants) {
    const { tensor, scale } = buildPixelValues(mode, normMode);
    const e1 = await enc.run({ pixel_values: tensor });
    // doc → grid の変換係数 (processed = doc × scale、grid = processed ÷ (S/G))
    const gridPerDoc = (scale * G) / S;
    // 被写体中心 (250, 300) をポイント指定してデコード (ポイントは 1024 空間の座標で渡す)
    const r = await dec.run({
      image_embeddings: e1.image_embeddings,
      image_positional_embeddings: e1.image_positional_embeddings,
      input_points: new ort.Tensor("float32", new Float32Array([250 * scale, 300 * scale]), [1, 1, 1, 2]),
      input_labels: new ort.Tensor("int64", new BigInt64Array([1n]), [1, 1, 1]),
    });
    const ious = [...r.iou_scores.data];
    let best = 0;
    for (let i = 1; i < ious.length; i++) if (ious[i] > ious[best]) best = i;
    // マスク (grid) と Ground Truth (doc 座標を grid へ変換) の IoU を集計
    let tp = 0;
    let fp = 0;
    let fn = 0;
    const procPerGrid = S / G; // grid 1px = processed 4px
    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) {
        const pred = r.pred_masks.data[best * G * G + y * G + x] > 0;
        // grid → processed (セル中心) → doc 変換して GT と比較
        const docX = (x * procPerGrid + procPerGrid / 2) / scale;
        const docY = (y * procPerGrid + procPerGrid / 2) / scale;
        const gt = docX >= BODY.x0 && docX < BODY.x1 && docY >= BODY.y0 && docY < BODY.y1;
        if (gt && pred) tp++;
        else if (!gt && pred) fp++;
        else if (gt && !pred) fn++;
      }
    }
    const maskIou = (tp / (tp + fp + fn)).toFixed(3);
    console.log(`${label} :: iou_score=${ious[best].toFixed(2)} maskIoU=${maskIou} (tp=${tp} fp=${fp} fn=${fn})`);
  }
})().catch((e) => console.error("ERR", e.message));
