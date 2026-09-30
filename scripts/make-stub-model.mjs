/**
 * scripts/make-stub-model.mjs — E2E テスト用のスタブ U-2-Net モデル (.onnx) 生成器
 *
 * 本物の u2net.onnx (約168MB) をテストに使わずに AI選択パイプライン全体を検証するため、
 * 「入力のチャンネル平均 (≒輝度) を saliency map として返す」最小モデルを
 * ONNX protobuf を直書きで生成する。
 *
 *   graph: input[1,3,320,320] → ReduceMean(axes=[1], keepdims=1) → d0[1,1,320,320]  (opset 11)
 *
 * 本物の U-2-Net と同じ入出力シグネチャを持つため、アプリ側は区別なしに動作する。
 * 出力は scripts/fixtures/u2net-stub.onnx (約 300 バイト) としてコミットする。
 */

/** varint エンコード (本モデルで使う値はすべて 2^21 未満) */
function varint(value) {
  const bytes = [];
  let v = value;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    bytes.push(b);
  } while (v > 0);
  return bytes;
}

/** field tag (wire type 2 = length-delimited) + 長さ + ペイロード */
function lenDelim(tag, bytes) {
  return [tag, ...varint(bytes.length), ...bytes];
}

function str(s) {
  return [...new TextEncoder().encode(s)];
}

/** TensorShapeProto.dim = { dim_value: v } */
function dim(value) {
  return lenDelim(0x0a, [0x08, ...varint(value)]);
}

/** TypeProto.Tensor = { elem_type: 1 (FLOAT), shape: { dim: [...] } } */
function tensorType(dims) {
  return lenDelim(0x0a, [0x08, 0x01, ...lenDelim(0x12, dims.flatMap(dim))]);
}

/** ValueInfoProto = { name, type } */
function valueInfo(name, dims) {
  return [...lenDelim(0x0a, str(name)), ...lenDelim(0x12, tensorType(dims))];
}

/** AttributeProto: axes = [1] (INTS / field 8 は proto2 非packed で出力する — packed は ort が拒否する) */
function attrAxes() {
  return [...lenDelim(0x0a, str("axes")), 0x40, 0x01, 0xa0, 0x01, 0x07];
}

/** AttributeProto: keepdims = 1 (INT / field 3) */
function attrKeepdims() {
  return [...lenDelim(0x0a, str("keepdims")), 0x18, 0x01, 0xa0, 0x01, 0x02];
}

/** スタブ U-2-Net モデル (ModelProto) を構築する */
export function buildStubOnnx() {
  const node = [
    ...lenDelim(0x0a, str("input")), // NodeProto.input
    ...lenDelim(0x12, str("d0")), // NodeProto.output
    ...lenDelim(0x22, str("ReduceMean")), // NodeProto.op_type
    ...lenDelim(0x2a, attrAxes()), // NodeProto.attribute
    ...lenDelim(0x2a, attrKeepdims()),
  ];
  const graph = [
    ...lenDelim(0x0a, node), // GraphProto.node
    ...lenDelim(0x12, str("u2net_stub")), // GraphProto.name
    ...lenDelim(0x5a, valueInfo("input", [1, 3, 320, 320])), // GraphProto.input  (field 11)
    ...lenDelim(0x62, valueInfo("d0", [1, 1, 320, 320])), // GraphProto.output (field 12)
  ];
  const model = [
    0x08, 0x08, // ir_version = 8
    ...lenDelim(0x3a, graph), // ModelProto.graph (field 7)
    ...lenDelim(0x42, [0x0a, 0x00, 0x10, 0x0b]), // opset_import = { domain: "", version: 11 }
  ];
  return Uint8Array.from(model);
}

/* --- CLI: node scripts/make-stub-model.mjs --- */
if (process.argv[1] && process.argv[1].endsWith("make-stub-model.mjs")) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const path = await import("node:path");
  const outDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "")), "fixtures");
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "u2net-stub.onnx");
  writeFileSync(outFile, buildStubOnnx());
  console.log(`stub model written: ${outFile} (${buildStubOnnx().length} bytes)`);
}
