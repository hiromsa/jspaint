# scripts/make_stub_sam.py — E2E テスト用のスタブ SlimSAM モデル (ONNX ×2) 生成器
#
# 本物の SlimSAM (vision_encoder 23MB + prompt_encoder_mask_decoder 17MB) をテストに使わずに
# AI選択パイプライン (encoder → embedding → decoder → logits マスク) を検証するため、
# 「入力のチャンネル平均を埋め込み / マスク logits として返す」最小モデルを生成する。
# 本物と同じ入出力シグネチャ (チャンネル数とマスク解像度だけ簡略) を持つ。
#
# 使い方: python scripts/make_stub_sam.py   (要: pip install onnx)
import os
import onnx
from onnx import helper, TensorProto

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def make_encoder() -> onnx.ModelProto:
    """pixel_values[1,3,1024,1024] → ReduceMean(axes=[1]) → embedding ×2"""
    x = helper.make_tensor_value_info("pixel_values", TensorProto.FLOAT, [1, 3, 1024, 1024])
    emb = helper.make_tensor_value_info("image_embeddings", TensorProto.FLOAT, [1, 1, 1024, 1024])
    pos = helper.make_tensor_value_info("image_positional_embeddings", TensorProto.FLOAT, [1, 1, 1024, 1024])
    nodes = [
        helper.make_node("ReduceMean", ["pixel_values"], ["emb"], axes=[1], name="rm"),
        helper.make_node("Identity", ["emb"], ["image_embeddings"], name="id1"),
        helper.make_node("Identity", ["emb"], ["image_positional_embeddings"], name="id2"),
    ]
    graph = helper.make_graph(nodes, "vision_encoder_stub", [x], [emb, pos])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 11)])
    model.ir_version = 8
    return model


def make_decoder() -> onnx.ModelProto:
    """埋め込み → マスク ×3 (同じ内容) / IoU スコア固定値"""
    pts = helper.make_tensor_value_info("input_points", TensorProto.FLOAT, ["batch", "point_batch", "nb_points", 2])
    labels = helper.make_tensor_value_info("input_labels", TensorProto.INT64, ["batch", "point_batch", "nb_points"])
    emb = helper.make_tensor_value_info("image_embeddings", TensorProto.FLOAT, [1, 1, 1024, 1024])
    pos = helper.make_tensor_value_info("image_positional_embeddings", TensorProto.FLOAT, [1, 1, 1024, 1024])
    iou = helper.make_tensor_value_info("iou_scores", TensorProto.FLOAT, [1, 1, 3])
    masks = helper.make_tensor_value_info("pred_masks", TensorProto.FLOAT, [1, 1, 3, 1024, 1024])
    nodes = [
        helper.make_node("Unsqueeze", ["image_embeddings"], ["u"], axes=[2], name="uq"),
        helper.make_node("Concat", ["u", "u", "u"], ["pred_masks"], axis=2, name="cat"),
        helper.make_node("Constant", [], ["iou_scores"], value=helper.make_tensor("iou", TensorProto.FLOAT, [1, 1, 3], [0.9, 0.5, 0.5]), name="c"),
    ]
    graph = helper.make_graph(nodes, "prompt_encoder_mask_decoder_stub", [pts, labels, emb, pos], [iou, masks])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 11)])
    model.ir_version = 8
    return model


if __name__ == "__main__":
    os.makedirs(FIXTURES, exist_ok=True)
    for name, model in [
        ("vision_encoder-stub.onnx", make_encoder()),
        ("prompt_encoder_mask_decoder-stub.onnx", make_decoder()),
    ]:
        path = os.path.join(FIXTURES, name)
        onnx.checker.check_model(model)
        onnx.save(model, path)
        print(f"stub model written: {path}")
