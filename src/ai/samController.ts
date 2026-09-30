/**
 * ai/samController.ts — AI被写体選択 (SlimSAM 対話セグメンテーション) の制御
 *
 * Affinity のオブジェクト選択風の操作:
 *   - クリック       = 対象ポイントを追加 → マスクを即時更新 (選択範囲を置き換え)
 *   - Alt + クリック = 除外ポイントを追加 → マスクから領域を削る
 *   - Enter          = ポイントを確定して終了 / Esc = ポイントをクリア
 *
 * 画像埋め込みは「ドキュメントサイズ + 編集リビジョン」をキーにキャッシュされ、
 * ポイントを動かす反復 (マスクの改善) ではデコーダのみ再実行するため高速。
 * モデルは IndexedDB にキャッシュされ、初回のみユーザーが 2 ファイルを読み込む。
 * UI への通知は hooks (toast) と onStatusChange (ui/panels が購読) のみ。
 */
import { createCanvas } from "../core/canvasUtils";
import { doc } from "../core/documentStore";
import { history } from "../core/historyStack";
import { hooks } from "../core/hooks";
import { selection } from "../core/selectionStore";
import { loadModel, removeModel, saveModel, SLIMSAM_DECODER_KEY, SLIMSAM_ENCODER_KEY } from "./modelStore";
import { SamEmbeddings, SamPoint, SamSegmenter } from "./samSegmenter";

/** モデル管理状態 (ui パネルの表示に使用) */
export type AiModelState = "unloaded" | "loading" | "ready";

/** 破綻したファイルを弾く下限 (極端に小さいファイル = 誤選択を拒否する) */
const MIN_MODEL_BYTES = 256;

/** 1 フレーム待って Busy 表示を描画させる (推論はメインスレッドをブロックするため) */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

class SamSelectController {
  private segmenter: SamSegmenter | null = null;
  private loading: Promise<void> | null = null;
  private busy = false;
  /** スロットごとの保持バイト列 (両方揃うとセッションを構築できる) */
  private encoderBuf: ArrayBuffer | null = null;
  private decoderBuf: ArrayBuffer | null = null;
  /** 画像埋め込みキャッシュ (キー = ドキュメントサイズ + 編集リビジョン) */
  private embedding: { key: string; data: SamEmbeddings } | null = null;
  /** 現在指定中のポイント群 (ドキュメント座標) */
  private points: SamPoint[] = [];
  /** 状態変更の通知先 (ui/panels が設定する) */
  onStatusChange: (() => void) | null = null;

  /** セッションが利用可能か (クリックでポイントを指定できるか) */
  get modelReady(): boolean {
    return this.segmenter !== null;
  }

  /** ロード / 推論中か */
  get isBusy(): boolean {
    return this.busy || this.loading !== null;
  }

  /** 現在のモデル状態 */
  get stateKind(): AiModelState {
    if (this.loading) return "loading";
    return this.segmenter ? "ready" : "unloaded";
  }

  /** パネル表示用のステータス文面 */
  get statusText(): string {
    if (this.loading) return "モデル準備中…";
    if (this.busy) return "解析中…";
    if (this.segmenter) return "利用可能 (キャッシュ済み)";
    if (this.encoderBuf || this.decoderBuf) {
      const have = [this.encoderBuf ? "エンコーダ" : "", this.decoderBuf ? "デコーダ" : ""].filter(Boolean).join("・");
      return `${have} 読み込み済み — もう1方も必要です`;
    }
    return "未読み込み (2ファイル)";
  }

  /** 指定中のポイントがあるか (Enter / Esc / ツール切替の判定用) */
  get hasPoints(): boolean {
    return this.points.length > 0;
  }

  private notify(): void {
    this.onStatusChange?.();
  }

  /**
   * キャッシュ済みモデルがあればセッションを用意する (ツール選択時に呼ぶ)。
   * 片方だけキャッシュされている場合は部分的に読み込んだ状態で終了する。
   */
  async warmup(): Promise<void> {
    if (this.segmenter || this.loading) return;
    this.loading = (async () => {
      try {
        this.notify();
        const [enc, dec] = await Promise.all([loadModel(SLIMSAM_ENCODER_KEY), loadModel(SLIMSAM_DECODER_KEY)]);
        this.encoderBuf = enc;
        this.decoderBuf = dec;
        if (!enc || !dec) return;
        this.segmenter = await SamSegmenter.create(new Uint8Array(enc), new Uint8Array(dec));
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

  /** ユーザーが選択した .onnx ファイル群をスロットへ振り分けて読み込む (複数選択可) */
  async loadModelFiles(files: File[]): Promise<void> {
    const pending: { file: File; key: string }[] = [];
    for (const file of files) {
      if (!/\.onnx$/i.test(file.name)) {
        hooks.toast(`${file.name}: ONNXモデル (.onnx) のみ読み込めます`, "info");
        continue;
      }
      const key = /vision/i.test(file.name) ? SLIMSAM_ENCODER_KEY : /prompt|decoder/i.test(file.name) ? SLIMSAM_DECODER_KEY : null;
      if (!key) {
        hooks.toast(`${file.name}: vision_encoder.onnx / prompt_encoder_mask_decoder.onnx を選択してください`, "info");
        continue;
      }
      if (file.size < MIN_MODEL_BYTES) {
        hooks.toast(`${file.name}: ファイルが小さすぎます`, "info");
        continue;
      }
      pending.push({ file, key });
    }
    if (!pending.length) return;

    this.loading = (async () => {
      try {
        this.notify();
        for (const { file, key } of pending) {
          const buf = await file.arrayBuffer();
          await saveModel(key, buf);
          if (key === SLIMSAM_ENCODER_KEY) this.encoderBuf = buf;
          else this.decoderBuf = buf;
        }
        await this.buildIfComplete(true);
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

  /** 両スロットが揃っていればセッションを構築する */
  private async buildIfComplete(withToast: boolean): Promise<void> {
    if (!this.encoderBuf || !this.decoderBuf) {
      if (withToast) hooks.toast("エンコーダとデコーダの両方の .onnx が必要です", "info");
      return;
    }
    const next = await SamSegmenter.create(new Uint8Array(this.encoderBuf), new Uint8Array(this.decoderBuf));
    await this.segmenter?.dispose();
    this.segmenter = next;
    this.embedding = null;
    this.points = [];
    if (withToast) hooks.toast("AIモデルを読み込みました — 被写体をクリックして選択", "ok");
  }


  /** キャッシュしたモデルを削除する */
  async forgetModel(): Promise<void> {
    if (this.loading) return;
    await removeModel(SLIMSAM_ENCODER_KEY);
    await removeModel(SLIMSAM_DECODER_KEY);
    await this.segmenter?.dispose();
    this.segmenter = null;
    this.encoderBuf = null;
    this.decoderBuf = null;
    this.embedding = null;
    this.points = [];
    this.notify();
    hooks.toast("AIモデルのキャッシュを削除しました", "info");
  }

  /** クリックでポイントを追加し、マスクを更新する (positive=false で除外ポイント) */
  async addPoint(docX: number, docY: number, positive: boolean): Promise<void> {
    console.log("[ai] addPoint", docX, docY, positive, "ready:", this.modelReady, "busy:", this.isBusy);
    if (!this.segmenter || this.busy) return;
    if (docX < 0 || docY < 0 || docX >= doc.width || docY >= doc.height) return;
    this.busy = true;
    this.notify();
    try {
      // 推論はメインスレッドをブロックするため、Busy 表示を先に描画させておく
      await nextFrame();
      // 先に埋め込みを用意する (ドキュメントが変わっていた場合は古いポイント座標がクリアされる)
      const emb = await this.ensureEmbedding();
      this.points.push({ x: docX, y: docY, positive });
      const logits = await this.segmenter.decode(emb, this.points, doc.width, doc.height);
      console.log("[ai] decode ok iou:", logits.iou, "size:", logits.size);
      const mask = renderLogitsMask(logits.data, logits.size, doc.width, doc.height);
      // SAM のマスクはポイント全体から毎回再構成されるため、選択範囲は常に置き換える
      selection.applySelection((g) => g.drawImage(mask, 0, 0), "new");
      hooks.toast(`AI選択を更新 (IoU ${(logits.iou * 100).toFixed(0)}% · ポイント ${this.points.length}件)`, "ok");
    } catch (e) {
      this.points.pop(); // 失敗したポイントは取り除く (リトライ可能にする)
      hooks.toast(`AI選択に失敗しました (${e instanceof Error ? e.message : "不明なエラー"})`, "info");
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  /** 指定中のポイントをクリアする (選択範囲はそのまま残る) */
  resetPoints(withToast = false): void {
    if (!this.hasPoints) return;
    this.points = [];
    this.notify();
    if (withToast) hooks.toast("ポイントをクリアしました", "info");
  }

  /** 画像埋め込みを取得する (同一ドキュメント内容ならキャッシュを再利用) */
  private async ensureEmbedding(): Promise<SamEmbeddings> {
    // pushUndo / undo / redo / clear でリビジョンが進むため、編集・読み込みで自動無効化される
    const key = `${doc.width}x${doc.height}#${history.revision}`;
    if (this.embedding?.key !== key) {
      // ドキュメントが変わったならポイント座標も無効になるためクリアする
      this.points = [];
      const data = await this.segmenter!.encode(doc.compositeCanvas());
      this.embedding = { key, data };
    }
    return this.embedding.data;
  }
}

/**
 * logits マスク (size×size) をドキュメント解像度へ拡大し、再二値化した白黒マスク canvas を返す。
 * マスクの確定は SAM の標準規則「logits > 0」。拡大はバイリニアで輪郭を滑らかにする。
 */
function renderLogitsMask(logits: Float32Array, size: number, w: number, h: number): HTMLCanvasElement {
  const small = createCanvas(size, size);
  const sg = small.getContext("2d")!;
  const img = sg.createImageData(size, size);
  for (let i = 0; i < logits.length; i++) {
    const o = i * 4;
    img.data[o] = 255;
    img.data[o + 1] = 255;
    img.data[o + 2] = 255;
    img.data[o + 3] = logits[i] > 0 ? 255 : 0;
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
export const samSelect = new SamSelectController();

