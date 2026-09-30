/**
 * rendering/maskDisplay.ts — Inpainting マスクレイヤーの「ドット網掛」表示
 * SD WebUI Forge の Inpaint マスク (high contrast 描画) と同じ見た目にする:
 * レイヤーの不透明部分を 10px 区切りの白黒チェッカーパターン × 50% 不透明度で表示する。
 * あくまで表示の変換であり、レイヤーの実データ (描画色・アルファ) や
 * エクスポート時に生成されるマスク画像には影響しない。
 */
import { createCanvas } from "../core/canvasUtils";

/** チェッカー 1 マスのサイズ (doc ピクセル)。Forge の contrast_scribbles と同じ 10px */
const PATTERN_SQUARE = 10;

/** 網掛全体の不透明度。Forge は描画キャンバスの CSS opacity 0.5 で相当する */
const DISPLAY_ALPHA = 0.5;

/** レイヤーサムネイル用のチェッカー 1 マスサイズ (サムネイル canvas ピクセル) */
const THUMB_SQUARE = 6;

/** 白黒チェッカーのパターンタイル (2×2 マス)。生成結果は不変のためマスサイズごとにキャッシュ */
const checkerTiles = new Map<number, HTMLCanvasElement>();

function getCheckerTile(square: number): HTMLCanvasElement {
  let tile = checkerTiles.get(square);
  if (tile) return tile;
  tile = createCanvas(square * 2, square * 2);
  const g = tile.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, square, square);
  g.fillRect(square, square, square, square);
  g.fillStyle = "#000000";
  g.fillRect(square, 0, square, square);
  g.fillRect(0, square, square, square);
  checkerTiles.set(square, tile);
  return tile;
}

/** canvas 表示用の合成結果 (doc 実寸)。フレームごとの再生成を避けるためサイズ一致の間は使い回す */
let work: HTMLCanvasElement | null = null;

/**
 * 全面チェッカーを source のアルファで切り抜いた canvas を返す。
 * out: 再利用する作業canvas (省略可)。サイズが一致する場合のみ中身を流用する。
 */
function composeChecker(source: HTMLCanvasElement, square: number, out?: HTMLCanvasElement | null): HTMLCanvasElement {
  const w = source.width;
  const h = source.height;
  const target = out && out.width === w && out.height === h ? out : createCanvas(w, h);
  const g = target.getContext("2d")!;
  // 1) 全面をチェッカーパターンで塗る
  g.clearRect(0, 0, w, h);
  const pattern = g.createPattern(getCheckerTile(square), "repeat");
  if (!pattern) return target;
  g.fillStyle = pattern;
  g.fillRect(0, 0, w, h);
  // 2) source のアルファで切り抜く (不透明部分だけがパターンとして残る)
  g.globalCompositeOperation = "destination-in";
  g.drawImage(source, 0, 0);
  g.globalCompositeOperation = "source-over";
  return target;
}

/**
 * Inpainting マスクレイヤーをドット網掛で view に描く。
 * source: 表示ソースの canvas (通常はレイヤー本体。フィルター / パペットワープの
 * プレビュー表示中はそのプレビュー canvas が渡される)。
 */
export function drawMaskLayerDisplay(g: CanvasRenderingContext2D, source: HTMLCanvasElement): void {
  work = composeChecker(source, PATTERN_SQUARE, work);
  // 半透明で view に重ねる (下のレイヤーが透けて見える網掛になる)
  g.save();
  g.globalAlpha = DISPLAY_ALPHA;
  g.drawImage(work, 0, 0);
  g.restore();
}

/**
 * レイヤーパネルのサムネイル用に、マスクレイヤーをドット網掛で描いた canvas を返す。
 * キャンバス表示と同じ白黒チェッカーだが、縮小サムネイルでもドットが読めるよう
 * マスは小さめ (THUMB_SQUARE) を使う。サムネイルには下地画像が無いため
 * 50% 不透明度にはせず不透明で描く (他レイヤーのサムネイルと同じ明るさの粒度)。
 */
export function drawMaskLayerThumb(source: HTMLCanvasElement, size: number): HTMLCanvasElement {
  // レイヤーをサムネイル解像度へ縮小する (色は使わずアルファのみ利用)
  const scaled = createCanvas(size, size);
  const sg = scaled.getContext("2d")!;
  sg.imageSmoothingQuality = "high";
  sg.drawImage(source, 0, 0, size, size);
  return composeChecker(scaled, THUMB_SQUARE);
}

