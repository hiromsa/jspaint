/**
 * core/filterEngine.ts — Inpainting 前処理フィルター (背景レイヤーに適用)
 * フィルター設定の保持・CSS filter 文字列の生成・ノイズ (グレイン) の生成・
 * 背景レイヤーの描画・確定 (ベイク) を担う。
 */
import { doc } from "./documentStore";
import { history } from "./historyStack";
import { hooks } from "./hooks";
import { selection } from "./selectionStore";
import { DOC_H, DOC_W } from "./types";

export class FilterEngine {
  blur = 0;
  noise = 0;
  /** ノイズの種類: "color" = RGB独立ランダム / "gray" = 明るさのみのグレイン */
  noiseMode: "color" | "gray" = "color";
  brightness = 100;
  contrast = 100;
  saturate = 100;
  hue = 0;
  on: Record<string, boolean> = { blur: false, noise: false, brightness: false, contrast: false, saturate: false, hue: false };

  /** 適用中のフィルターを CSS filter 文字列として生成 */
  filterString(): string {
    const parts: string[] = [];
    if (this.on.blur && this.blur > 0) parts.push(`blur(${this.blur}px)`);
    if (this.on.brightness) parts.push(`brightness(${this.brightness}%)`);
    if (this.on.contrast) parts.push(`contrast(${this.contrast}%)`);
    if (this.on.saturate) parts.push(`saturate(${this.saturate}%)`);
    if (this.on.hue) parts.push(`hue-rotate(${this.hue}deg)`);
    return parts.length ? parts.join(" ") : "none";
  }

  filtersActive(): boolean {
    return Object.values(this.on).some(Boolean);
  }

  /** フィルター設定をリセット (値のみ。UI 同期は呼び出し側で行う) */
  resetValues(): void {
    Object.keys(this.on).forEach((k) => (this.on[k] = false));
    this.blur = 0;
    this.noise = 0;
    this.noiseMode = "color";
    this.brightness = 100;
    this.contrast = 100;
    this.saturate = 100;
    this.hue = 0;
  }

  /**
   * 背景レイヤー(元画像)を描画する。
   * フィルター有効時、選択範囲があれば「その範囲のみ」にフィルターを適用する。
   */
  drawBaseLayer(g: CanvasRenderingContext2D): void {
    const base = doc.baseLayer();
    if (!base?.visible) return;
    if (!this.filtersActive()) {
      g.drawImage(base.canvas, 0, 0);
      return;
    }
    // 1) フィルター適用版を全面に描く
    g.filter = this.filterString();
    g.drawImage(base.canvas, 0, 0);
    if (this.on.noise && this.noise > 0) this.drawNoise(g);
    g.filter = "none";
    // 2) 選択範囲の外側を「フィルターなし」で上書き
    if (selection.hasSelection) {
      const tg = this.fxTmp.getContext("2d")!;
      tg.globalCompositeOperation = "source-over";
      tg.clearRect(0, 0, DOC_W, DOC_H);
      tg.drawImage(base.canvas, 0, 0);
      tg.globalCompositeOperation = "destination-out";
      tg.drawImage(selection.mask, 0, 0);
      tg.globalCompositeOperation = "source-over";
      g.drawImage(this.fxTmp, 0, 0);
    }
  }

  /**
   * フィルターを確定(ベイク): 現在のフィルター結果を背景レイヤーのピクセルに焼き込み、
   * フィルター設定をリセットする。選択範囲がある場合はその範囲のみ焼き込む。
   */
  bake(): void {
    const base = doc.baseLayer();
    if (!base || !this.filtersActive()) {
      hooks.toast("有効なフィルターがありません", "info");
      return;
    }
    history.pushUndo(base);

    // 1) フィルター適用済み画像を作る
    const filtered = document.createElement("canvas");
    filtered.width = DOC_W;
    filtered.height = DOC_H;
    const fg = filtered.getContext("2d")!;
    fg.filter = this.filterString();
    fg.drawImage(base.canvas, 0, 0);
    fg.filter = "none";
    if (this.on.noise && this.noise > 0) this.drawNoise(fg);

    // 2) 背景レイヤーに焼き込む(選択範囲があればその範囲のみ)
    if (selection.hasSelection) {
      const masked = document.createElement("canvas");
      masked.width = DOC_W;
      masked.height = DOC_H;
      const mg = masked.getContext("2d")!;
      mg.drawImage(filtered, 0, 0);
      mg.globalCompositeOperation = "destination-in";
      mg.drawImage(selection.mask, 0, 0);
      mg.globalCompositeOperation = "source-over";
      base.ctx.drawImage(masked, 0, 0);
    } else {
      base.ctx.clearRect(0, 0, DOC_W, DOC_H);
      base.ctx.drawImage(filtered, 0, 0);
    }

    // 3) フィルター設定をリセット
    this.resetValues();
    hooks.syncFilterUI();
    hooks.renderLayers();
    hooks.markDirty();
    hooks.render();
    hooks.toast(selection.hasSelection ? "選択範囲にフィルターを確定しました" : "フィルターを確定しました(ベイク)", "fx");
  }

  /** ノイズ(グレイン) — シード固定の決定論的パターンをキャッシュして再利用 (カラー / グレー) */
  drawNoise(g: CanvasRenderingContext2D): void {
    const strength = this.noise / 100;
    if (strength <= 0) return;
    g.save();
    g.globalAlpha = strength;
    g.drawImage(this.getNoiseCanvas(this.noiseMode), 0, 0);
    g.restore();
  }

  private noiseCaches: Record<"color" | "gray", HTMLCanvasElement | null> = { color: null, gray: null };

  private getNoiseCanvas(mode: "color" | "gray"): HTMLCanvasElement {
    const cached = this.noiseCaches[mode];
    if (cached) return cached;
    const n = document.createElement("canvas");
    n.width = DOC_W;
    n.height = DOC_H;
    const nc = n.getContext("2d")!;
    const img = nc.createImageData(DOC_W, DOC_H);
    let s = 0x9e3779b9; // xorshift32 固定シード
    const rand = (): number => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
    for (let i = 0; i < img.data.length; i += 4) {
      if (mode === "gray") {
        // グレースケールノイズ: 明るさのみのランダム値 (フィルムグレイン)
        const v = rand() * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      } else {
        // カラーノイズ: RGB に独立したランダム値 (カラーグレイン)
        img.data[i] = rand() * 255;
        img.data[i + 1] = rand() * 255;
        img.data[i + 2] = rand() * 255;
      }
      img.data[i + 3] = 255;
    }
    nc.putImageData(img, 0, 0);
    this.noiseCaches[mode] = n;
    return n;
  }

  /** フィルター適用作業用の一時canvas */
  private readonly fxTmp = document.createElement("canvas");
}

/** アプリ全体で共有するフィルターエンジン */
export const filters = new FilterEngine();