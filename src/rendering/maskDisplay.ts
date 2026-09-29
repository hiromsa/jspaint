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

/** 白黒チェッカーのパターンタイル (2×2 マス = 20×20px)。生成結果は不変のためキャッシュする */
let checkerTile: HTMLCanvasElement | null = null;

function getCheckerTile(): HTMLCanvasElement {
  if (checkerTile) return checkerTile;
  checkerTile = createCanvas(PATTERN_SQUARE * 2, PATTERN_SQUARE * 2);
  const g = checkerTile.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, PATTERN_SQUARE, PATTERN_SQUARE);
  g.fillRect(PATTERN_SQUARE, PATTERN_SQUARE, PATTERN_SQUARE, PATTERN_SQUARE);
  g.fillStyle = "#000000";
  g.fillRect(PATTERN_SQUARE, 0, PATTERN_SQUARE, PATTERN_SQUARE);
  g.fillRect(0, PATTERN_SQUARE, PATTERN_SQUARE, PATTERN_SQUARE);
  return checkerTile;
}

/** パターン合成用の作業 canvas (レイヤーと同じ doc 実寸。サイズ変更時に作り直す) */
let work: HTMLCanvasElement | null = null;

/**
 * Inpainting マスクレイヤーをドット網掛で描く。
 * source: 表示ソースの canvas (通常はレイヤー本体。フィルター / パペットワープの
 * プレビュー表示中はそのプレビュー canvas が渡される)。
 */
export function drawMaskLayerDisplay(g: CanvasRenderingContext2D, source: HTMLCanvasElement): void {
  if (!work || work.width !== source.width || work.height !== source.height) {
    work = createCanvas(source.width, source.height);
  }
  const wg = work.getContext("2d")!;
  // 1) 全面をチェッカーパターンで塗る
  wg.clearRect(0, 0, work.width, work.height);
  const pattern = wg.createPattern(getCheckerTile(), "repeat");
  if (!pattern) return;
  wg.fillStyle = pattern;
  wg.fillRect(0, 0, work.width, work.height);
  // 2) レイヤーのアルファで切り抜く (不透明部分だけがパターンとして残る)
  wg.globalCompositeOperation = "destination-in";
  wg.drawImage(source, 0, 0);
  wg.globalCompositeOperation = "source-over";
  // 3) 半透明で view に重ねる (下のレイヤーが透けて見える網掛になる)
  g.save();
  g.globalAlpha = DISPLAY_ALPHA;
  g.drawImage(work, 0, 0);
  g.restore();
}
