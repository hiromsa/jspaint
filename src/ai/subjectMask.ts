/**
 * ai/subjectMask.ts — saliency map から選択マスクを得る純粋関数群
 * DOM に依存しないため Node 単体テスト (scripts/verify-aisubject.ts) から直接検証できる。
 */

/**
 * min-max 正規化 (rembg の前処理と同じ)。
 * 全体が単色 (range = 0) の場合はすべて 0 を返す (「被写体が見つからない」扱いになる)。
 */
export function normalizeMinMax(data: Float32Array): Float32Array {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const out = new Float32Array(data.length);
  const range = max - min;
  if (range <= 0) return out;
  for (let i = 0; i < data.length; i++) out[i] = (data[i] - min) / range;
  return out;
}

/** 正規化済みマップを 0/1 の二値マスクへ変換する (threshold: 0..1) */
export function thresholdMap(norm: Float32Array, threshold: number): Uint8Array {
  const out = new Uint8Array(norm.length);
  for (let i = 0; i < norm.length; i++) out[i] = norm[i] >= threshold ? 1 : 0;
  return out;
}

/** 連結成分ラベリングの結果 (label 0 = 非選択 / 1.. = 成分) */
export interface ComponentTable {
  labels: Int32Array;
  /** sizes[label] = 成分のピクセル数 (index 0 は未使用) */
  sizes: Int32Array;
  /** 成分数 */
  count: number;
}

/** 二値マスクを 4 近傍で連結成分分解する (BFS / 320x320 なら数 ms) */
export function labelComponents(mask: Uint8Array, w: number, h: number): ComponentTable {
  const labels = new Int32Array(mask.length);
  const sizes: number[] = [0];
  const queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const label = sizes.length;
    let size = 0;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    while (head < tail) {
      const idx = queue[head++];
      size++;
      const x = idx % w;
      const y = (idx / w) | 0;
      if (x > 0 && mask[idx - 1] && !labels[idx - 1]) {
        labels[idx - 1] = label;
        queue[tail++] = idx - 1;
      }
      if (x < w - 1 && mask[idx + 1] && !labels[idx + 1]) {
        labels[idx + 1] = label;
        queue[tail++] = idx + 1;
      }
      if (y > 0 && mask[idx - w] && !labels[idx - w]) {
        labels[idx - w] = label;
        queue[tail++] = idx - w;
      }
      if (y < h - 1 && mask[idx + w] && !labels[idx + w]) {
        labels[idx + w] = label;
        queue[tail++] = idx + w;
      }
    }
    sizes.push(size);
  }
  return { labels, sizes: Int32Array.from(sizes), count: sizes.length - 1 };
}

/** (x, y) を含む成分のラベル (なければ 0) */
export function labelAt(labels: Int32Array, w: number, x: number, y: number): number {
  return labels[y * w + x] ?? 0;
}

/** 指定ラベルの成分だけを残した二値マスクを返す */
export function maskOfLabel(_mask: Uint8Array, labels: Int32Array, label: number): Uint8Array {
  const out = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) out[i] = labels[i] === label ? 1 : 0;
  return out;
}
