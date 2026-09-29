/**
 * core/canvasUtils.ts — canvas に対する純粋なユーティリティ
 * エディタの状態に依存しない (引数で渡された canvas / 値のみを扱う)。
 * ドキュメントは可変サイズのため、サイズは常に引数または対象 canvas から受け取る。
 */

/** 空の canvas を生成 */
export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** canvas の内容を複製 */
export function clone(c: HTMLCanvasElement): HTMLCanvasElement {
  const n = createCanvas(c.width, c.height);
  n.getContext("2d")!.drawImage(c, 0, 0);
  return n;
}

/** マスクcanvasを指定色に着色 */
export function tintMask(mask: HTMLCanvasElement, color: string): void {
  const g = mask.getContext("2d")!;
  g.globalCompositeOperation = "source-in";
  g.fillStyle = color;
  g.fillRect(0, 0, mask.width, mask.height);
  g.globalCompositeOperation = "source-over";
}

/** 角丸矩形のパスを構築 (canvas 標準 roundRect を使わない代替) */
export function roundRectPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/** #rrggbb → rgba(...) 文字列 */
export function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * スキャンライン flood fill。composite 上の (cx, cy) を起点に、
 * 許容度以内の類似色領域を白二値マスクcanvasとして返す。
 * サイズは composite 自身から取得する (ドキュメントは可変)。
 */
export function floodMask(composite: HTMLCanvasElement, cx: number, cy: number, tolerance: number): HTMLCanvasElement {
  const w = composite.width;
  const h = composite.height;
  const img = composite.getContext("2d")!.getImageData(0, 0, w, h);
  const d = img.data;
  const sx = Math.max(0, Math.min(w - 1, cx | 0));
  const sy = Math.max(0, Math.min(h - 1, cy | 0));
  const si = sy * w + sx;
  const r0 = d[si * 4], g0 = d[si * 4 + 1], b0 = d[si * 4 + 2];
  const thresh = (tolerance / 100) * 383;
  const mask = new Uint8Array(w * h);
  const match = (i: number): boolean => {
    const dr = d[i * 4] - r0, dg = d[i * 4 + 1] - g0, db = d[i * 4 + 2] - b0;
    return Math.abs(dr) + Math.abs(dg) + Math.abs(db) <= thresh;
  };

  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    let i = y * w + x;
    while (x >= 0 && !mask[i] && match(i)) { x--; i--; }
    x++; i++;
    let up = false;
    let down = false;
    while (x < w && !mask[i] && match(i)) {
      mask[i] = 1;
      if (y > 0) {
        const ui = i - w;
        const m = !mask[ui] && match(ui);
        if (m && !up) { stack.push(x, y - 1); up = true; } else if (!m) up = false;
      }
      if (y < h - 1) {
        const di = i + w;
        const m = !mask[di] && match(di);
        if (m && !down) { stack.push(x, y + 1); down = true; } else if (!m) down = false;
      }
      x++; i++;
    }
  }

  const out = createCanvas(w, h);
  const oc = out.getContext("2d")!;
  const od = oc.createImageData(w, h);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      od.data[i * 4] = 255;
      od.data[i * 4 + 1] = 255;
      od.data[i * 4 + 2] = 255;
      od.data[i * 4 + 3] = 255;
    }
  }
  oc.putImageData(od, 0, 0);
  return out;
}