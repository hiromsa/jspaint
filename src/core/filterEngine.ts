/**
 * core/filterEngine.ts — フィルター設定の保持と適用
 * - FilterSettings: フィルターパラメータの保持と効果の生成
 *   (CSS filter 文字列 / ノイズ / シャープ)。
 *   全体フィルター (FilterEngine) とフィルターペン専用設定 (filterPenFx) で共用する。
 * - FilterEngine: 全体フィルター。編集対象レイヤーへのプレビュー表示と確定 (ベイク) を担う。
 *   適用先は「編集対象レイヤー」(アクティブ + Ctrl+クリックで追加した複数レイヤー)。
 *   フィルターペンは painting/filterPen.ts が filterPenFx を参照して独自に焼き込むため、
 *   フィルタータブの設定 (プレビュー / ベイク) とは独立して動作する。
 */
import { doc } from "./documentStore";
import { history } from "./historyStack";
import { hooks } from "./hooks";
import { selection } from "./selectionStore";
import { createCanvas } from "./canvasUtils";
import type { Layer } from "./types";

/** 0〜255 へクランプする (シャープ計算の加算オーバーフロー対策) */
function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

export class FilterSettings {
  blur = 0;
  /** シャープの強度 (0〜100%)。CSS filter に存在しないため applySharpen() で自前適用する */
  sharpen = 0;
  noise = 0;
  /** ノイズの種類: "color" = RGB独立ランダム / "gray" = 明るさのみのグレイン */
  noiseMode: "color" | "gray" = "color";
  brightness = 100;
  contrast = 100;
  saturate = 100;
  hue = 0;
  on: Record<string, boolean> = { blur: false, sharpen: false, noise: false, brightness: false, contrast: false, saturate: false, hue: false };

  /** 適用中のフィルターを CSS filter 文字列として生成 (シャープは自前実装のため含まれない) */
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
    this.sharpen = 0;
    this.noise = 0;
    this.noiseMode = "color";
    this.brightness = 100;
    this.contrast = 100;
    this.saturate = 100;
    this.hue = 0;
  }

  /** シャープ (アンシャープマスク) のぼかし参照半径 (px) */
  private static readonly SHARPEN_RADIUS = 1;

  /**
   * シャープ (アンシャープマスク) を適用した canvas を返す。
   * 「出力 = 元画像 + 強度 × (元画像 − ぼかし参照)」を premultiply 空間で計算し、
   * エッジのコントラストを強調する。CSS filter にシャープは存在しないため自前実装で、
   * layerPreview / bake / フィルターペンはここで得た canvas をソースとして使う。
   * アルファは変化させず、半透明エッジの色ズレも premultiply 計算で回避する。
   * シャープ無効時は source をそのまま返す (呼び出し側に分岐を持たせない)。
   */
  applySharpen(source: HTMLCanvasElement): HTMLCanvasElement {
    if (!this.on.sharpen || this.sharpen <= 0) return source;
    const w = source.width;
    const h = source.height;
    if (!w || !h) return source;

    // ぼかし参照画像 (GPU 高速な CSS blur を利用)
    const blurred = createCanvas(w, h);
    const bg = blurred.getContext("2d")!;
    bg.filter = `blur(${FilterSettings.SHARPEN_RADIUS}px)`;
    bg.drawImage(source, 0, 0);
    bg.filter = "none";

    // 元画像へ上書き書き込みしつつ差分を加算する
    const src = source.getContext("2d")!.getImageData(0, 0, w, h);
    const ref = bg.getImageData(0, 0, w, h);
    const s = src.data;
    const r = ref.data;
    const amount = this.sharpen / 100;
    for (let i = 0; i < s.length; i += 4) {
      const alpha = s[i + 3];
      if (alpha === 0) continue; // 完全透明ピクセルは変化させない
      const af = alpha / 255;
      const afRef = r[i + 3] / 255;
      // premultiply した値で差分を取り、加算後に unpremultiply して戻す
      const sr = s[i] * af;
      const sg = s[i + 1] * af;
      const sb = s[i + 2] * af;
      const rr = r[i] * afRef;
      const rg = r[i + 1] * afRef;
      const rb = r[i + 2] * afRef;
      s[i] = clampByte((sr + amount * (sr - rr)) / af);
      s[i + 1] = clampByte((sg + amount * (sg - rg)) / af);
      s[i + 2] = clampByte((sb + amount * (sb - rb)) / af);
    }

    const out = createCanvas(w, h);
    out.getContext("2d")!.putImageData(src, 0, 0);
    return out;
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

  /** ドキュメントサイズ変更後に呼ぶ (画像読み込み時)。ノイズキャッシュは実寸依存のため無効化する */
  onDocResized(): void {
    this.noiseCaches = { color: null, gray: null };
  }

  private noiseCaches: Record<"color" | "gray", HTMLCanvasElement | null> = { color: null, gray: null };

  private getNoiseCanvas(mode: "color" | "gray"): HTMLCanvasElement {
    const cached = this.noiseCaches[mode];
    if (cached) return cached;
    const n = document.createElement("canvas");
    n.width = doc.width;
    n.height = doc.height;
    const nc = n.getContext("2d")!;
    const img = nc.createImageData(doc.width, doc.height);
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
}

/**
 * FilterEngine — 全体フィルター (フィルタータブ)。
 * 編集対象レイヤーへのプレビュー表示と確定 (ベイク) を担う。
 */
export class FilterEngine extends FilterSettings {
  /**
   * レイヤーの表示用プレビューを返す。
   * 編集対象レイヤーでフィルターが有効な場合、フィルター適用済み
   * (選択範囲があれば「その範囲のみ」) の canvas を返し、それ以外は null。
   */
  layerPreview(l: Layer): HTMLCanvasElement | null {
    if (!this.filtersActive()) return null;
    if (l.locked || !doc.editTargets().includes(l)) return null;

    // シャープは CSS filter に無いため、ソースへ事前適用した canvas を描画に使う
    const source = this.applySharpen(l.canvas);
    const g = this.ensureTmp();
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, doc.width, doc.height);
    g.filter = this.filterString();
    g.drawImage(source, 0, 0);
    g.filter = "none";
    if (this.on.noise && this.noise > 0) this.drawNoise(g);
    // 選択範囲の外側を「フィルターなし」で上書き (範囲内のみ適用)
    if (selection.hasSelection) {
      const g2 = this.ensureTmp2();
      g2.globalCompositeOperation = "source-over";
      g2.clearRect(0, 0, doc.width, doc.height);
      g2.drawImage(source, 0, 0);
      g2.globalCompositeOperation = "destination-out";
      g2.drawImage(selection.mask, 0, 0);
      g2.globalCompositeOperation = "source-over";
      g.drawImage(this.fxTmp2, 0, 0);
    }
    return this.fxTmp;
  }

  /**
   * フィルターを確定(ベイク): 現在のフィルター結果を編集対象レイヤーの
   * ピクセルに焼き込み、フィルター設定をリセットする。
   * 選択範囲がある場合はその範囲のみ焼き込む。
   */
  bake(): void {
    const targets = doc.editTargets();
    if (!targets.length || !this.filtersActive()) {
      hooks.toast("有効なフィルターがありません", "info");
      return;
    }
    history.pushUndo(targets);

    for (const base of targets) {
      // 1) フィルター適用済み画像を作る (シャープはソースへ事前適用)
      const source = this.applySharpen(base.canvas);
      const filtered = createCanvas(doc.width, doc.height);
      const fg = filtered.getContext("2d")!;
      fg.filter = this.filterString();
      fg.drawImage(source, 0, 0);
      fg.filter = "none";
      if (this.on.noise && this.noise > 0) this.drawNoise(fg);

      // 2) レイヤーに焼き込む(選択範囲があればその範囲のみ)
      if (selection.hasSelection) {
        const masked = createCanvas(doc.width, doc.height);
        const mg = masked.getContext("2d")!;
        mg.drawImage(filtered, 0, 0);
        mg.globalCompositeOperation = "destination-in";
        mg.drawImage(selection.mask, 0, 0);
        mg.globalCompositeOperation = "source-over";
        base.ctx.drawImage(masked, 0, 0);
      } else {
        base.ctx.clearRect(0, 0, doc.width, doc.height);
        base.ctx.drawImage(filtered, 0, 0);
      }
    }

    // 3) フィルター設定をリセット
    this.resetValues();
    hooks.syncFilterUI();
    hooks.renderLayers();
    hooks.markDirty();
    hooks.render();
    hooks.toast(
      targets.length > 1
        ? `${targets.length} レイヤーにフィルターを確定しました(ベイク)`
        : "フィルターを確定しました(ベイク)",
      "fx",
    );
  }

  /** プレビュー用の一時canvas (フィルター適用済み表示) をドキュメント実寸へ合わせて返す */
  private ensureTmp(): CanvasRenderingContext2D {
    if (this.fxTmp.width !== doc.width) this.fxTmp.width = doc.width;
    if (this.fxTmp.height !== doc.height) this.fxTmp.height = doc.height;
    return this.fxTmp.getContext("2d")!;
  }

  /** プレビュー用の一時canvas 2 (選択範囲外の元画像保持用) をドキュメント実寸へ合わせて返す */
  private ensureTmp2(): CanvasRenderingContext2D {
    if (this.fxTmp2.width !== doc.width) this.fxTmp2.width = doc.width;
    if (this.fxTmp2.height !== doc.height) this.fxTmp2.height = doc.height;
    return this.fxTmp2.getContext("2d")!;
  }

  /** フィルター適用作業用の一時canvas */
  private readonly fxTmp = document.createElement("canvas");
  private readonly fxTmp2 = document.createElement("canvas");
}

/** アプリ全体で共有するフィルターエンジン (フィルタータブ = 画像全体への適用) */
export const filters = new FilterEngine();

/** フィルターペン専用のフィルター設定 (フィルタータブとは独立。ツールタブで編集する) */
export const filterPenFx = new FilterSettings();