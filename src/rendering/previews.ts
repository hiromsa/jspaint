/**
 * rendering/previews.ts — キャンバス上のオーバーレイ描画
 * ストローク / 選択のドラッグ中プレビュー、パペットワープのメッシュ・ピン、
 * サイズバッジ、円形カーソル。
 */
import { hexA, roundRectPath } from "../core/canvasUtils";
import { samSelect } from "../ai/samController";
import { state } from "../core/editorState";
import { interaction } from "../core/interactionState";
import { selection } from "../core/selectionStore";
import { CIRCLE_CURSOR_TOOLS } from "../core/toolDefs";
import { docToScreenX, docToScreenY, viewport } from "../core/viewState";
import { warpSession } from "../puppet/warpSession";
import { meshWarpSession } from "../meshwarp/warpSession";
import { MW_SIDES } from "../meshwarp/meshGrid";

export function drawStrokePreview(g: CanvasRenderingContext2D): void {
  if (!interaction.preview) return;
  const { x0, y0, x1, y1, tool } = interaction.preview;
  g.save();
  g.strokeStyle = "#fff";
  g.fillStyle = hexA(state.fg, 0.45);
  g.lineWidth = 1 / state.zoom;
  g.setLineDash([4 / state.zoom, 3 / state.zoom]);
  const w = x1 - x0;
  const h = y1 - y0;
  if (tool === "line") {
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  } else if (tool === "rect") {
    g.fillRect(x0, y0, w, h);
    g.strokeRect(x0, y0, w, h);
  } else if (tool === "ellipse") {
    g.beginPath();
    g.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
  g.restore();
}

export function drawSelectionPreview(g: CanvasRenderingContext2D): void {
  g.save();
  g.lineWidth = 1 / state.zoom;

  // AI被写体選択: 囲み選択のドラッグ中プレビュー (緑の破線枠)
  const samBox = samSelect.boxPreview;
  if (samBox) {
    g.strokeStyle = "#4ade80";
    g.setLineDash([5 / state.zoom, 4 / state.zoom]);
    g.strokeRect(
      Math.min(samBox.x0, samBox.x1),
      Math.min(samBox.y0, samBox.y1),
      Math.abs(samBox.x1 - samBox.x0),
      Math.abs(samBox.y1 - samBox.y0),
    );
    g.setLineDash([]);
  }

  // 矩形選択: ドラッグ中の範囲を色付きオーバーレイ + 破線枠で表示
  if (interaction.preview && interaction.preview.tool === "select-rect") {
    const { x0, y0, x1, y1 } = interaction.preview;
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    // モード色 (確定時の適用モードと対応): 新規=青 / 追加(Shift)=緑 / 除外(Alt)=赤
    const mode = interaction.dragMods ?? state.selMode;
    const tint = mode === "add" ? "34, 197, 94" : mode === "sub" ? "239, 68, 68" : "96, 165, 250";
    g.fillStyle = `rgba(${tint}, 0.28)`;
    g.fillRect(x, y, w, h);
    // 枠: どの背景でも見えるよう黒の下地線 + 白破線 (既存選択がある間は ants に合わせて破線が流れる)
    g.strokeStyle = "rgba(0, 0, 0, 0.8)";
    g.strokeRect(x, y, w, h);
    g.strokeStyle = "#fff";
    g.setLineDash([4 / state.zoom, 3 / state.zoom]);
    g.lineDashOffset = (-selection.antPhase * 2) / state.zoom;
    g.strokeRect(x, y, w, h);
  }

  if (interaction.lassoPath && interaction.lassoPath.length > 1) {
    g.strokeStyle = "#fff";
    g.setLineDash([4 / state.zoom, 3 / state.zoom]);
    g.beginPath();
    g.moveTo(interaction.lassoPath[0].x, interaction.lassoPath[0].y);
    for (const p of interaction.lassoPath) g.lineTo(p.x, p.y);
    g.stroke();
  }
  if (state.tool === "polygon" && (interaction.polyPoints.length > 0 || interaction.polyDrag)) {
    const pts = interaction.polyDrag ? interaction.polyPoints.concat(interaction.polyDrag.pts) : interaction.polyPoints;
    g.strokeStyle = "#fff";
    g.setLineDash([4 / state.zoom, 3 / state.zoom]);
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (const p of pts) g.lineTo(p.x, p.y);
    if (interaction.polyHover) g.lineTo(interaction.polyHover.x, interaction.polyHover.y);
    g.stroke();

    // 頂点ハンドル (確定済み頂点のみ。始点は緑ドット)
    interaction.polyPoints.forEach((p, i) => {
      g.beginPath();
      g.arc(p.x, p.y, (i === 0 ? 6 : 3.5) / state.zoom, 0, Math.PI * 2);
      g.setLineDash([]);
      if (i === 0) {
        g.fillStyle = "#22c55e";
        g.fill();
        g.strokeStyle = "#fff";
      } else {
        g.fillStyle = "#fff";
        g.fill();
        g.strokeStyle = "#000";
      }
      g.stroke();
    });
  }
  g.restore();
}

/** ドラッグ中の図形 / 矩形選択サイズバッジ (W×H、直線は長さ) */
export function drawDragSizeBadge(g: CanvasRenderingContext2D): void {
  if (!interaction.preview) return;
  const { tool, x0, y0, x1, y1 } = interaction.preview;
  let label: string;
  if (tool === "line") {
    label = `Len: ${Math.round(Math.hypot(x1 - x0, y1 - y0))} px`;
  } else {
    label = `W: ${Math.round(Math.abs(x1 - x0))}  H: ${Math.round(Math.abs(y1 - y0))}`;
  }
  // 矩形選択: モード修飾中 (Shift=追加 / Alt=除外) は先頭に記号を添える
  if (tool === "select-rect" && interaction.dragMods) {
    label = `${interaction.dragMods === "add" ? "＋" : "−"} ${label}`;
  }
  const padX = 7;
  const padY = 4;
  g.save();
  g.font = "600 11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const bw = g.measureText(label).width + padX * 2;
  const bh = 11 + padY * 2;
  // ドラッグ矩形の右下 (スクリーン座標) に配置し、ビューポート内にクランプ
  let bx = docToScreenX(Math.max(x0, x1)) + 10;
  let by = docToScreenY(Math.max(y0, y1)) + 12;
  bx = Math.min(Math.max(4, bx), viewport.vw - bw - 4);
  by = Math.min(Math.max(4, by), viewport.vh - bh - 4);
  g.fillStyle = "rgba(10, 12, 18, 0.85)";
  g.strokeStyle = "rgba(255, 255, 255, 0.22)";
  g.lineWidth = 1;
  g.beginPath();
  roundRectPath(g, bx, by, bw, bh, 5);
  g.fill();
  g.stroke();
  g.fillStyle = "#fff";
  g.textBaseline = "middle";
  g.fillText(label, bx + padX, by + bh / 2 + 0.5);
  g.restore();
}

/** ブラシ系ツールの円形カーソル (黒の縁取り + 白の円 + 中心点) */
export function drawCursor(g: CanvasRenderingContext2D): void {
  if (!interaction.cursorPos) return;
  if (!CIRCLE_CURSOR_TOOLS.includes(state.tool)) return;
  const r = Math.max(2, (state.brushSize * state.zoom) / 2);
  const x = docToScreenX(interaction.cursorPos.x);
  const y = docToScreenY(interaction.cursorPos.y);
  g.save();
  g.lineWidth = 1;
  g.strokeStyle = "rgba(0,0,0,0.75)";
  g.beginPath();
  g.arc(x, y, r + 1, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = "rgba(255,255,255,0.9)";
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = "rgba(255,255,255,0.9)";
  g.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
  g.restore();
}

/** パペットワープのオーバーレイ (変形後メッシュ線 + ピン) */
export function drawPuppetWarpOverlay(g: CanvasRenderingContext2D): void {
  const s = warpSession;
  if (!s.active || !s.mesh) return;
  const zoom = state.zoom;
  const d = s.deformed;
  g.save();
  g.lineWidth = 1 / zoom;

  // メッシュ線 (変形後の三角形の辺をまとめて 1 パスで描く)
  g.strokeStyle = "rgba(255, 255, 255, 0.14)";
  g.beginPath();
  for (const { indices } of s.mesh.triangles) {
    const [i0, i1, i2] = indices;
    g.moveTo(d[i0].x, d[i0].y);
    g.lineTo(d[i1].x, d[i1].y);
    g.lineTo(d[i2].x, d[i2].y);
    g.closePath();
  }
  g.stroke();

  // ピン (通常=白 / 固定=青 / ホバー・ドラッグ=黄縁)。ドラッグ中は元位置に残像を出す
  for (const pin of s.mesh.pins) {
    const r = 5 / zoom;
    const isHot = pin.id === s.dragPinId || pin.id === s.hoverPinId;
    if (isHot) {
      g.setLineDash([3 / zoom, 3 / zoom]);
      g.strokeStyle = "rgba(251, 191, 36, 0.8)";
      g.beginPath();
      g.moveTo(pin.original.x, pin.original.y);
      g.lineTo(pin.current.x, pin.current.y);
      g.stroke();
      g.setLineDash([]);
      g.beginPath();
      g.arc(pin.original.x, pin.original.y, r * 0.6, 0, Math.PI * 2);
      g.strokeStyle = "rgba(251, 191, 36, 0.6)";
      g.stroke();
    }
    g.beginPath();
    g.arc(pin.current.x, pin.current.y, r, 0, Math.PI * 2);
    g.fillStyle = pin.isPinned ? "#60a5fa" : "#ffffff";
    g.fill();
    g.strokeStyle = isHot ? "#fbbf24" : "rgba(0, 0, 0, 0.85)";
    g.lineWidth = (isHot ? 2 : 1.5) / zoom;
    g.stroke();
    g.lineWidth = 1 / zoom;
  }
  g.restore();
}

/** メッシュワープのオーバーレイ (変形後エッジ曲線 + ノード + 選択ノードのハンドル) */
export function drawMeshWarpOverlay(g: CanvasRenderingContext2D): void {
  const s = meshWarpSession;
  const grid = s.grid;
  if (!s.active || !grid) return;
  const zoom = state.zoom;
  g.save();
  g.lineWidth = 1 / zoom;

  // エッジ曲線 (変形後 pos 空間のベジェ chain をまとめて 1 パスで描く)
  g.strokeStyle = "rgba(147, 197, 253, 0.55)";
  g.beginPath();
  for (const patch of grid.patches) {
    for (const side of MW_SIDES) {
      const chain = patch[side];
      const p0 = grid.nodePos(chain[0], "pos");
      g.moveTo(p0.x, p0.y);
      for (let i = 0; i < chain.length - 1; i++) {
        const [, q1, q2, q3] = grid.edgePoints(grid.node(chain[i]), grid.node(chain[i + 1]), "pos");
        g.bezierCurveTo(q1.x, q1.y, q2.x, q2.y, q3.x, q3.y);
      }
    }
  }
  g.stroke();

  // ホバー / ドラッグ中のエッジを強調
  const highlight = s.drag?.kind === "edge" ? s.drag.drag : s.hoverEdge;
  if (highlight) {
    const [h0, h1, h2, h3] = grid.edgePoints(grid.node(highlight.aId), grid.node(highlight.bId), "pos");
    g.strokeStyle = "rgba(251, 191, 36, 0.95)";
    g.lineWidth = 2 / zoom;
    g.beginPath();
    g.moveTo(h0.x, h0.y);
    g.bezierCurveTo(h1.x, h1.y, h2.x, h2.y, h3.x, h3.y);
    g.stroke();
    g.lineWidth = 1 / zoom;
  }

  // ハンドル (選択ノードのもの=青 / 隣接ノードの対向=シアン。仮想表示は破線)
  for (const h of s.visibleHandles()) {
    const nodePos = grid.nodePos(h.nodeId, "pos");
    const lineColor = h.opposite ? "rgba(103, 232, 249, 0.85)" : "rgba(147, 197, 253, 0.95)";
    g.strokeStyle = h.virtual ? hexA("#93c5fd", 0.45) : lineColor;
    g.setLineDash(h.virtual ? [3 / zoom, 3 / zoom] : []);
    g.beginPath();
    g.moveTo(nodePos.x, nodePos.y);
    g.lineTo(h.point.x, h.point.y);
    g.stroke();
    g.setLineDash([]);
    g.beginPath();
    g.arc(h.point.x, h.point.y, 3.2 / zoom, 0, Math.PI * 2);
    g.fillStyle = h.virtual ? "rgba(224, 242, 254, 0.65)" : "#e0f2fe";
    g.fill();
    g.strokeStyle = "rgba(0, 0, 0, 0.85)";
    g.lineWidth = 1.2 / zoom;
    g.stroke();
    g.lineWidth = 1 / zoom;
  }

  // ノード (白点。選択中は黄縁)
  for (const n of grid.nodes.values()) {
    const r = 4 / zoom;
    const isSel = n.id === s.selectedNodeId;
    g.beginPath();
    g.arc(n.pos.x, n.pos.y, r, 0, Math.PI * 2);
    g.fillStyle = "#ffffff";
    g.fill();
    g.strokeStyle = isSel ? "#fbbf24" : "rgba(0, 0, 0, 0.85)";
    g.lineWidth = (isSel ? 2 : 1.5) / zoom;
    g.stroke();
    g.lineWidth = 1 / zoom;
  }
  g.restore();
}