/**
 * ai/aiSelectController.ts — AI被写体選択の制御
 *
 * クリックされた位置を含む「被写体」を saliency map から切り出して選択範囲へ合成する。
 *   composite → 320x320 推論 (ドキュメント変更までキャッシュ) → min-max 正規化 → しきい値化
 *   → 連結成分分解 → クリック点を含む成分 → ドキュメント解像度へ拡大 + 再二値化 → applySelection
 *
 * モデルは IndexedDB にキャッシュされ、初回のみユーザーが .onnx ファイルを読み込む。
 * UI への通知は hooks (toast) と onStatusChange (ui/panels が購読) のみ。
 */
import { createCanvas } from "../core/canvasUtils";
import { doc } from "../core/documentStore";
import { history } from "../core/historyStack";
import { hooks } from "../core/hooks";
import { state } from "../core/editorState";
import { selection } from "../core/selectionStore";
import type { SelMode } from "../core/types";
import { loadModel, removeModel, saveModel } from "./modelStore";
import { labelAt, labelComponents, maskOfLabel, normalizeMinMax, thresholdMap } from "./subjectMask";
import { U2NetSegmenter } from "./u2netSegmenter";

/** モデル管理状態 (ui パネルの表示に使用) */
export type AiModelState = "unloaded" | "loading" | "ready";

/** 破綻したファイルを弾く下限 (極端に小さいファイル = 誤選択を拒否する) */
const MIN_MODEL_BYTES = 64;

/** 1 フレーム待って Busy 表示を描画させる (推論はメインスレッドをブロックするため) */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

class AiSelectController {
  private segmenter: U2NetSegmenter | null = null;
  private loading: Promise<void> | null = null;
  private busy = false;
  /** 推論キャッシュ (キー = ドキュメントサイズ + 編集リビジョン) */
  private saliency: { key: string; data: Float32Array; size: number } | null = null;
  /** 状態変更の通知先 (ui/panels が設定する) */
  onStatusChange: (() => void) | null = null;

  /** セッションが利用可能か (クリックで選択動作に入れるか) */
  get modelReady(): boolean {
    return this.segmenter !== null;
  }

  /** モデルのロード / 推論中か */
  get isBusy(): boolean {
    return this.busy || this.loading !== null;
  }

  /** 現在のモデル状態 */
  get stateKind(): AiModelState {
    if (this.loading) return "loading";
    return this.segmenter ? "ready" : "unloaded";
  }

  private notify(): void {
    this.onStatusChange?.();
  }

  /**
   * キャッシュ済みモデルがあればセッションを用意する (ツール選択時に呼ぶ)。
   * 未キャッシュなら unloaded のまま終了する (呼び出し側がファイル選択へ誘導)。
   */
  async warmup(): Promise<void> {
    if (this.segmenter || this.loading) return;
    this.loading = (async () => {
      try {
        this.notify();
        const cached = await loadModel();
        if (!cached) return;
        this.segmenter = await U2NetSegmenter.create(new Uint8Array(cached));
      } catch {
        this.segmenter = null;
        hooks.toast("キャッシュしたAIモデルを読み込めませんでした。モデルを再読み込みしてください", "info");
      } finally {
        this.loading = null;
        this.notify();
      }
    })();
    await this.loading;
  }

  /** ユーザーが選択した .onnx ファイルを読み込み、キャッシュへ保存する */
  async loadModelFile(file: File): Promise<void> {
    if (!/\.onnx$/i.test(file.name)) {
      hooks.toast("ONNXモデル (.onnx) を選択してください (rembg の u2net.onnx)", "info");
      return;
    }
    if (file.size < MIN_MODEL_BYTES) {
      hooks.toast("モデルファイルが小さすぎます。u2net.onnx (約168MB) を選択してください", "info");
      return;
    }
    this.loading = (async () => {
      try {
        this.notify();
        const buf = await file.arrayBuffer();
        const next = await U2NetSegmenter.create(new Uint8Array(buf));
        await this.segmenter?.dispose();
        this.segmenter = next;
        this.saliency = null;
        const cached = await saveModel(buf);
        hooks.toast(cached ? `${file.name} を読み込みました (キャッシュ済み — 次回から自動起動)` : `${file.name} を読み込みました`, "ok");
      } catch (e) {
        this.segmenter = null;
        console.warn("[ai] model load failed:", e);
        hooks.toast(`AIモデルを読み込めませんでした (${e instanceof Error ? e.message : "不明なエラー"})`, "info");
      } finally {
        this.loading = null;
        this.notify();
      }
    })();
    await this.loading;
  }


  /** キャッシュしたモデルを削除する */
  async forgetModel(): Promise<void> {
    await removeModel();
    if (this.loading) return;
    await this.segmenter?.dispose();
    this.segmenter = null;
    this.saliency = null;
    this.notify();
    hooks.toast("AIモデルのキャッシュを削除しました", "info");
  }

  /**
   * クリック点 (ドキュメント座標) を含む被写体を選択範囲へ合成する。
   * mode は既存の選択系と同じ new / add / sub (Shift / Alt 修飾)。
   */
  async selectAt(docX: number, docY: number, mode: SelMode): Promise<void> {
    if (!this.segmenter || this.busy) return;
    if (docX < 0 || docY < 0 || docX >= doc.width || docY >= doc.height) return;
    this.busy = true;
    this.notify();
    try {
      // 推論はメインスレッドをブロックするため、Busy 表示を先に描画させておく
      await nextFrame();
      const sal = await this.ensureSaliency();
      const norm = normalizeMinMax(sal.data);
      const binary = thresholdMap(norm, state.aiThreshold / 100);
      const { labels, sizes } = labelComponents(binary, sal.size, sal.size);
      const sx = Math.max(0, Math.min(sal.size - 1, Math.floor((docX / doc.width) * sal.size)));
      const sy = Math.max(0, Math.min(sal.size - 1, Math.floor((docY / doc.height) * sal.size)));
      const label = labelAt(labels, sal.size, sx, sy);
      if (label === 0) {
        hooks.toast("クリック位置に被写体が見つかりません — しきい値を下げてください", "info");
        return;
      }
      const mask = renderRegionMask(maskOfLabel(binary, labels, label), sal.size, doc.width, doc.height);
      selection.applySelection((g) => g.drawImage(mask, 0, 0), mode);
      hooks.toast(`AI被写体選択 (${sizes[label].toLocaleString()} px · しきい値 ${state.aiThreshold}%)`, "ok");
    } catch (e) {
      hooks.toast(`AI選択に失敗しました (${e instanceof Error ? e.message : "不明なエラー"})`, "info");
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  /** saliency map を取得する (同一ドキュメント内容ならキャッシュを再利用) */
  private async ensureSaliency(): Promise<{ data: Float32Array; size: number }> {
    // pushUndo / undo / redo / clear でリビジョンが進むため、編集・読み込みで自動無効化される
    const key = `${doc.width}x${doc.height}#${history.revision}`;
    if (this.saliency?.key === key) return this.saliency;
    const result = await this.segmenter!.infer(doc.compositeCanvas());
    this.saliency = { key, data: result.data, size: result.width };
    return this.saliency;
  }
}

/**
 * 320 解像度の成分マスクをドキュメント解像度へ拡大し、再二値化した白黒マスク canvas を返す。
 * 拡大はバイリニア (imageSmoothing) で輪郭を滑らかにし、α 128 以上を選択とみなす。
 */
function renderRegionMask(region: Uint8Array, size: number, w: number, h: number): HTMLCanvasElement {
  const small = createCanvas(size, size);
  const sg = small.getContext("2d")!;
  const img = sg.createImageData(size, size);
  for (let i = 0; i < region.length; i++) {
    const o = i * 4;
    img.data[o] = 255;
    img.data[o + 1] = 255;
    img.data[o + 2] = 255;
    img.data[o + 3] = region[i] ? 255 : 0;
  }
  sg.putImageData(img, 0, 0);

  const out = createCanvas(w, h);
  const og = out.getContext("2d")!;
  og.imageSmoothingEnabled = true;
  og.imageSmoothingQuality = "medium";
  og.drawImage(small, 0, 0, w, h);

  // 拡大時の補間で生じた半透明エッジを二値化 (SelectionStore の白黒マスク規約に揃える)
  const scaled = og.getImageData(0, 0, w, h);
  for (let i = 0; i < w * h; i++) {
    const on = scaled.data[i * 4 + 3] >= 128;
    scaled.data[i * 4] = 255;
    scaled.data[i * 4 + 1] = 255;
    scaled.data[i * 4 + 2] = 255;
    scaled.data[i * 4 + 3] = on ? 255 : 0;
  }
  og.putImageData(scaled, 0, 0);
  return out;
}

/** アプリ全体で共有する AI選択コントローラ */
export const aiSelect = new AiSelectController();
