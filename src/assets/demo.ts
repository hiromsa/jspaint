/**
 * assets/demo.ts — 単体動作用のデモ素材 (640×640 のサンプル写真をCanvasに描画)
 * 外部画像に依存しないため、file:// でも動作する。
 */
import { DOC_H, DOC_W } from "../core/types";

/** 夕暮れの湖畔風のサンプル画像を生成 */
export function createDemoImage(w = DOC_W, h = DOC_H): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d")!;

  const horizon = h * 0.58;

  // --- 空 (グラデーション) ---
  const sky = g.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, "#1b2a5e");
  sky.addColorStop(0.45, "#7a4b8f");
  sky.addColorStop(0.75, "#d8734f");
  sky.addColorStop(1, "#f2a65a");
  g.fillStyle = sky;
  g.fillRect(0, 0, w, horizon);

  // --- 太陽 + グロー ---
  const sunX = w * 0.68;
  const sunY = horizon - 52;
  const glow = g.createRadialGradient(sunX, sunY, 4, sunX, sunY, 130);
  glow.addColorStop(0, "rgba(255,236,190,0.95)");
  glow.addColorStop(0.25, "rgba(255,190,120,0.45)");
  glow.addColorStop(1, "rgba(255,170,110,0)");
  g.fillStyle = glow;
  g.fillRect(sunX - 140, sunY - 140, 280, 280);
  g.fillStyle = "#ffe9c4";
  g.beginPath();
  g.arc(sunX, sunY, 26, 0, Math.PI * 2);
  g.fill();

  // --- 雲 ---
  const cloud = (cx: number, cy: number, s: number, a: number) => {
    g.fillStyle = `rgba(255,205,170,${a})`;
    for (const [dx, dy, r] of [[-34, 6, 26], [0, -6, 34], [34, 4, 24], [-14, 10, 22], [16, 12, 20]] as const) {
      g.beginPath();
      g.ellipse(cx + dx * s, cy + dy * s, r * s, r * 0.55 * s, 0, 0, Math.PI * 2);
      g.fill();
    }
  };
  cloud(w * 0.22, h * 0.2, 1.1, 0.5);
  cloud(w * 0.5, h * 0.3, 0.8, 0.4);
  cloud(w * 0.82, h * 0.14, 0.7, 0.45);

  // --- 遠山 ---
  const mountains = (baseY: number, amp: number, color: string, seed: number) => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, baseY);
    for (let x = 0; x <= w; x += 8) {
      const y =
        baseY -
        Math.abs(Math.sin((x + seed) * 0.008) * amp) -
        Math.abs(Math.sin((x + seed) * 0.021 + 2) * amp * 0.35);
      g.lineTo(x, y);
    }
    g.lineTo(w, baseY);
    g.closePath();
    g.fill();
  };
  mountains(horizon, 90, "#4a3a6b", 0);
  mountains(horizon, 52, "#33284e", 180);

  // --- 湖面 ---
  const lake = g.createLinearGradient(0, horizon, 0, h);
  lake.addColorStop(0, "#e78a4e");
  lake.addColorStop(0.3, "#8a4f63");
  lake.addColorStop(1, "#231d3f");
  g.fillStyle = lake;
  g.fillRect(0, horizon, w, h - horizon);

  // --- 太陽の反射 ---
  g.save();
  g.globalAlpha = 0.55;
  for (let y = horizon + 6; y < h; y += 7) {
    const t = (y - horizon) / (h - horizon);
    const width = 60 * (1 - t * 0.4) + Math.sin(y * 0.7) * 14;
    g.fillStyle = `rgba(255,214,150,${0.5 * (1 - t)})`;
    g.fillRect(sunX - width / 2 + Math.sin(y * 0.35) * 10, y, width, 2.5);
  }
  g.restore();

  // --- 波のハイライト ---
  g.save();
  for (let i = 0; i < 130; i++) {
    const y = horizon + 8 + Math.random() * (h - horizon - 14);
    const t = (y - horizon) / (h - horizon);
    const x = Math.random() * w;
    g.fillStyle = `rgba(255,235,210,${0.05 + 0.16 * (1 - t)})`;
    g.fillRect(x, y, 14 + Math.random() * 40, 1.4);
  }
  g.restore();

  // --- 手前の桟橋シルエット ---
  g.fillStyle = "#150f28";
  g.beginPath();
  g.moveTo(w * 0.08, h);
  g.lineTo(w * 0.2, h * 0.84);
  g.lineTo(w * 0.34, h * 0.84);
  g.lineTo(w * 0.42, h);
  g.closePath();
  g.fill();

  return cv;
}