/**
 * interaction/pointer.ts — ポインタ (マウス / ペン) 入力処理
 * ツールごとの down / move / up ディスパッチ、パン、ズームホイール、多角形選択の確定。
 */
import { floodMask, tintMask } from "../core/canvasUtils";
import { samSelect } from "../ai/samController";
import { doc } from "../core/documentStore";
import { history } from "../core/historyStack";
import { filterPenFx } from "../core/filterEngine";
import { interaction } from "../core/interactionState";
import { selection } from "../core/selectionStore";
import { state } from "../core/editorState";
import { TOOLS } from "../core/toolDefs";
import { screenToDoc, setZoom } from "../core/viewState";
import { $ } from "../ui/dom";
import { markDirty, toast } from "../ui/feedback";
import { openAiModelSetup } from "../ui/panels";
import { render, view } from "../rendering/renderer";
import { PIN_HIT_RADIUS, warpSession } from "../puppet/warpSession";
import {
  BLOAT_HOLD_RATE,
  bloatSign,
  bloatStamp,
  startBloatHold,
  stopBloatHold,
} from "../painting/bloat";
import {
  applyFilterPenSegment,
  beginFilterPenStroke,
  endFilterPenStroke,
} from "../painting/filterPen";
import { paintStroke, drawLineSeg, setupStrokeStyle } from "../painting/stroke";
import { retouchStroke, smudgeStamp, toneMode, toneStamp } from "../painting/retouch";

const stage = $("#stage");

function localPos(e: PointerEvent | MouseEvent): { x: number; y: number } {
  const r = view.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onPointerDown(e: PointerEvent): void {
  if (e.button === 2) return;
  const s = localPos(e);
  const d = screenToDoc(s.x, s.y);
  view.setPointerCapture(e.pointerId);

  if (state.spacePan || state.tool === "pan" || e.button === 1) {
    interaction.panning = { sx: s.x - state.panX, sy: s.y - state.panY };
    stage.classList.add("is-panning");
    return;
  }

  switch (state.tool) {
    case "brush":
    case "eraser": {
      history.pushUndo();
      markDirty();
      doc.editTargets().forEach((l) => paintStroke(l.ctx, (g) => drawLineSeg(g, d, d), d.x, d.y, d.x, d.y, state.brushSize / 2 + 2));
      interaction.strokeLast = d;
      break;
    }
    case "smudge":
    case "bloat":
    case "dodge":
    case "burn": {
      history.pushUndo();
      markDirty();
      if (state.tool === "bloat") {
        // クリック時のフィードバックとして 0.25 秒分の控えめな膨張を 1 回適用し、
        // 以降の適用は rAF ホールドループ (時間ベース) に一任する
        doc.editTargets().forEach((l) => bloatStamp(l, d, bloatSign(e.altKey), BLOAT_HOLD_RATE * 0.25));
        startBloatHold();
      } else if (state.tool !== "smudge") {
        const mode = toneMode(e.altKey);
        doc.editTargets().forEach((l) => toneStamp(l, mode, d));
      }
      interaction.retouchLast = d;
      break;
    }
    case "filter-pen": {
      if (!filterPenFx.filtersActive()) {
        toast("先にツールタブで「フィルター効果」を有効にしてください", "info");
        break;
      }
      history.pushUndo();
      markDirty();
      beginFilterPenStroke(d);
      interaction.filterPenLast = d;
      break;
    }
    case "puppet-warp": {
      // セッションが無い (開始に失敗した / 空のレイヤー等) 場合は再試行
      if (!warpSession.active) {
        warpSession.start();
        break;
      }
      const hit = warpSession.pickPin(d, PIN_HIT_RADIUS / state.zoom);
      if (hit && hit.isPinned) {
        toast("固定ピンは移動できません · ダブルクリックで削除", "info");
        break;
      }
      if (hit) {
        warpSession.dragPinId = hit.id;
      } else {
        // クリックした位置にピンを打ち、押したままドラッグで調整できる
        warpSession.addPin(d, e.altKey);
        if (e.altKey) toast("固定ピンを追加", "info");
      }
      break;
    }
    case "line":
    case "rect":
    case "ellipse":
    case "select-rect":
      interaction.dragStart = d;
      interaction.preview = { tool: state.tool, x0: d.x, y0: d.y, x1: d.x, y1: d.y };
      break;
    case "lasso":
      interaction.lassoPath = [d];
      break;
    case "polygon":
      // クリック=頂点追加 / ドラッグ=フリーハンド。判別は pointerup で行う
      interaction.polyDrag = { pts: [d], moved: false };
      interaction.polyHover = d;
      break;
    case "mask-pen": {
      history.pushUndo();
      markDirty();
      const mode = interaction.dragMods ?? state.selMode;
      selection.beginMaskStroke(mode);
      selection.paintMaskSegment(d, d);
      interaction.maskStroke = { mode, last: d };
      break;
    }
    case "bucket": {
      const m = floodMask(doc.compositeCanvas(), d.x, d.y, state.tolerance);
      if (selection.hasSelection) {
        // 選択範囲がある場合は選択範囲との交差部分のみを塗る
        const mg = m.getContext("2d")!;
        mg.globalCompositeOperation = "destination-in";
        mg.drawImage(selection.mask, 0, 0);
        mg.globalCompositeOperation = "source-over";
      }
      tintMask(m, state.fg);
      history.pushUndo();
      doc.editTargets().forEach((l) => {
        l.ctx.save();
        setupStrokeStyle(l.ctx);
        l.ctx.drawImage(m, 0, 0);
        l.ctx.restore();
      });
      markDirty();
      break;
    }
    case "wand": {
      const m = floodMask(doc.compositeCanvas(), d.x, d.y, state.tolerance);
      selection.applySelection((g) => g.drawImage(m, 0, 0));
      toast(`類似色範囲を選択 (許容度 ${state.tolerance})`, "info");
      break;
    }
    case "ai-select": {
      // モデル未読み込みならセットアップモーダル (ダウンロード元の案内) を開く
      if (!samSelect.modelReady) {
        openAiModelSetup();
        break;
      }
      // DOWN ではジェスチャ開始のみ。UP で移動量に応じて「クリック (ポイント) / ドラッグ (囲み)」を判定する
      samSelect.pointerDown(d, !e.altKey);
      break;
    }
    case "eyedropper": {
      const c = doc.pickColor(d.x, d.y);
      if (c) {
        state.fg = c;
        ($("#swatch-fg") as HTMLButtonElement).style.background = c;
        ($("#color-input") as HTMLInputElement).value = c;
        toast(`色を取得: ${c.toUpperCase()}`, "ok");
      }
      break;
    }
    default:
      break;
  }
  render();
}

function onPointerMove(e: PointerEvent): void {
  const s = localPos(e);
  const d = screenToDoc(s.x, s.y);
  interaction.cursorPos = d;

  const inside = d.x >= 0 && d.y >= 0 && d.x < doc.width && d.y < doc.height;
  $("#st-pos").textContent = inside ? `X: ${Math.floor(d.x)}  Y: ${Math.floor(d.y)}` : "X: —  Y: —";

  if (interaction.panning) {
    state.panX = s.x - interaction.panning.sx;
    state.panY = s.y - interaction.panning.sy;
  } else if (interaction.strokeLast) {
    const from = interaction.strokeLast;
    doc.editTargets().forEach((l) => paintStroke(l.ctx, (g) => drawLineSeg(g, from, d), from.x, from.y, d.x, d.y, state.brushSize / 2 + 2));
    interaction.strokeLast = d;
  } else if (interaction.retouchLast) {
    if (state.tool === "bloat") {
      // 膨張の適用は rAF ホールドループ (時間ベース) に一任し、ここでは位置追従のみ行う。
      // ここでスタンプすると mouse の micro-move (125-1000Hz) ごとに全強度スタンプが発射し、
      // 押しっぱなし中の手ブレ方向 (多くは左上) へ画像が激しく引っ張られてしまう
      interaction.retouchLast = d;
    } else {
      const from = interaction.retouchLast;
      doc.editTargets().forEach((l) => {
        if (state.tool === "smudge") retouchStroke((f, t) => smudgeStamp(l, f, t), from, d);
        else retouchStroke((_f, t) => toneStamp(l, toneMode(e.altKey), t), from, d);
      });
      interaction.retouchLast = d;
    }
  } else if (interaction.filterPenLast) {
    applyFilterPenSegment(interaction.filterPenLast, d);
    interaction.filterPenLast = d;
  } else if (interaction.preview && interaction.dragStart) {
    let { x, y } = d;
    if (e.shiftKey) {
      const dx = x - interaction.dragStart.x;
      const dy = y - interaction.dragStart.y;
      if (interaction.preview.tool === "line") {
        if (Math.abs(dx) > Math.abs(dy) * 2) y = interaction.dragStart.y;
        else if (Math.abs(dy) > Math.abs(dx) * 2) x = interaction.dragStart.x;
        else {
          const m = Math.min(Math.abs(dx), Math.abs(dy));
          x = interaction.dragStart.x + Math.sign(dx) * m;
          y = interaction.dragStart.y + Math.sign(dy) * m;
        }
      } else {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        x = interaction.dragStart.x + Math.sign(dx || 1) * m;
        y = interaction.dragStart.y + Math.sign(dy || 1) * m;
      }
    }
    interaction.preview.x1 = x;
    interaction.preview.y1 = y;
  } else if (interaction.lassoPath) {
    const lastP = interaction.lassoPath[interaction.lassoPath.length - 1];
    if (Math.hypot(d.x - lastP.x, d.y - lastP.y) * state.zoom > 2) interaction.lassoPath.push(d);
  } else if (warpSession.dragPinId != null) {
    // パペットワープ: ドラッグ中ピンを追従させ、メッシュ変形プレビューを更新
    warpSession.moveDragPin(d);
  } else if (interaction.maskStroke) {
    selection.paintMaskSegment(interaction.maskStroke.last, d);
    interaction.maskStroke.last = d;
  } else if (interaction.polyDrag) {
    // ドラッグ中は投げ縄のように連続頂点を収集
    const lastP = interaction.polyDrag.pts[interaction.polyDrag.pts.length - 1];
    if (Math.hypot(d.x - lastP.x, d.y - lastP.y) * state.zoom > 3) {
      interaction.polyDrag.pts.push(d);
      interaction.polyDrag.moved = true;
    }
    interaction.polyHover = d;
  } else if (state.tool === "polygon" && interaction.polyPoints.length > 0) {
    interaction.polyHover = d;
  } else if (state.tool === "ai-select") {
    // 囲み選択のドラッグ中: プレビュー矩形を更新
    samSelect.pointerDrag(d);
  }

  // パペットワープ: ホバー中ピンの追跡 (カーソル形状のフィードバック)
  if (state.tool === "puppet-warp" && warpSession.active && warpSession.dragPinId == null) {
    const hit = warpSession.pickPin(d, PIN_HIT_RADIUS / state.zoom);
    warpSession.hoverPinId = hit?.id ?? null;
    stage.style.cursor = hit ? "pointer" : TOOLS[state.tool].cursor;
  }

  render();
}

function onPointerUp(e: PointerEvent): void {
  interaction.panning = null;
  stage.classList.remove("is-panning");

  // AI被写体選択: 移動量に応じて「クリック (ポイント追加) / ドラッグ (囲み選択)」を確定する
  if (state.tool === "ai-select") {
    const lp = localPos(e);
    const d = screenToDoc(lp.x, lp.y);
    void samSelect.pointerUp(d);
  }

  // 図形 / 矩形選択の確定
  if (interaction.preview && interaction.dragStart) {
    const p = { ...interaction.preview };
    interaction.preview = null;
    if (p.tool === "select-rect") {
      const x = Math.min(p.x0, p.x1);
      const y = Math.min(p.y0, p.y1);
      const w = Math.abs(p.x1 - p.x0);
      const h = Math.abs(p.y1 - p.y0);
      if (w > 2 && h > 2) selection.applySelection((g) => g.fillRect(x, y, w, h));
    } else {
      history.pushUndo();
      markDirty();
      const px0 = Math.min(p.x0, p.x1);
      const py0 = Math.min(p.y0, p.y1);
      const px1 = Math.max(p.x0, p.x1);
      const py1 = Math.max(p.y0, p.y1);
      const lwPad = state.brushSize / 2 + 2;
      doc.editTargets().forEach((l) => {
        const ctx = l.ctx;
        if (p.tool === "line") {
          paintStroke(ctx, (g) => drawLineSeg(g, { x: p.x0, y: p.y0 }, { x: p.x1, y: p.y1 }), p.x0, p.y0, p.x1, p.y1, lwPad);
        } else if (p.tool === "rect") {
          paintStroke(
            ctx,
            (g) => {
              if (state.fillShape) g.fillRect(px0, py0, px1 - px0, py1 - py0);
              else g.strokeRect(px0, py0, px1 - px0, py1 - py0);
            },
            px0, py0, px1, py1,
            state.fillShape ? 1 : lwPad,
          );
        } else if (p.tool === "ellipse") {
          paintStroke(
            ctx,
            (g) => {
              g.beginPath();
              g.ellipse((p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, Math.abs(p.x1 - p.x0) / 2, Math.abs(p.y1 - p.y0) / 2, 0, 0, Math.PI * 2);
              if (state.fillShape) g.fill();
              else g.stroke();
            },
            px0, py0, px1, py1,
            state.fillShape ? 1 : lwPad,
          );
        }
      });
    }
  }

  // 投げ縄の確定
  if (interaction.lassoPath) {
    const pts = interaction.lassoPath;
    interaction.lassoPath = null;
    if (pts.length > 2) {
      selection.applySelection((g) => {
        g.beginPath();
        g.moveTo(pts[0].x, pts[0].y);
        for (const p of pts) g.lineTo(p.x, p.y);
        g.closePath();
        g.fill();
      });
    }
  }

  // 選択ペンのストローク確定 → Marching ants を更新
  if (interaction.maskStroke) {
    interaction.maskStroke = null;
    selection.commitMaskStroke();
  }

  // 多角形: クリック=頂点追加 / ドラッグ=フリーハンド連結
  if (interaction.polyDrag) {
    const drag = interaction.polyDrag;
    interaction.polyDrag = null;
    if (!drag.moved) {
      // クリック: 始点近傍なら閉じる、そうでなければ頂点を追加
      const d = drag.pts[0];
      const nearStart = interaction.polyPoints.length > 2 && Math.hypot(d.x - interaction.polyPoints[0].x, d.y - interaction.polyPoints[0].y) * state.zoom < 10;
      if (nearStart) closePolygon();
      else interaction.polyPoints.push(d);
    } else {
      for (const p of drag.pts) {
        const lp = interaction.polyPoints[interaction.polyPoints.length - 1];
        if (!lp || Math.hypot(p.x - lp.x, p.y - lp.y) * state.zoom > 1.5) interaction.polyPoints.push(p);
      }
    }
    interaction.polyHover = null;
  }

  stopBloatHold();
  warpSession.endDrag();
  interaction.strokeLast = null;
  interaction.retouchLast = null;
  interaction.filterPenLast = null;
  endFilterPenStroke();
  interaction.dragStart = null;
  render();
}

/** 多角形選択を閉じて選択範囲へ確定する */
export function closePolygon(): void {
  const pts = interaction.polyPoints;
  interaction.polyPoints = [];
  interaction.polyDrag = null;
  interaction.polyHover = null;
  if (pts.length >= 3) {
    selection.applySelection((g) => {
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (const p of pts) g.lineTo(p.x, p.y);
      g.closePath();
      g.fill();
    });
    toast(`多角形選択を確定 (${pts.length}頂点)`, "ok");
  }
  render();
}

/** 多角形選択を取り消す */
export function cancelPolygon(): void {
  if (interaction.polyPoints.length > 0 || interaction.polyDrag) {
    interaction.polyPoints = [];
    interaction.polyDrag = null;
    interaction.polyHover = null;
    render();
    toast("多角形選択を取消", "info");
  }
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const s = localPos(e);
  if (e.ctrlKey || !e.shiftKey) {
    const factor = Math.exp(-e.deltaY * 0.0015);
    setZoom(state.zoom * factor, s.x, s.y);
  } else {
    state.panX -= e.deltaX;
    state.panY -= e.deltaY;
    render();
  }
}

/** view canvas への入力イベントを配線する */
export function bindCanvasEvents(): void {
  view.addEventListener(
    "pointerdown",
    (e) => {
      interaction.dragMods = e.shiftKey ? "add" : e.altKey ? "sub" : null;
      onPointerDown(e);
    },
  );
  view.addEventListener("pointermove", onPointerMove);
  view.addEventListener("pointerup", onPointerUp);
  view.addEventListener("pointercancel", onPointerUp);
  view.addEventListener("pointerleave", () => {
    interaction.cursorPos = null;
    $("#st-pos").textContent = "X: —  Y: —";
    render();
  });
  view.addEventListener("wheel", onWheel, { passive: false });
  view.addEventListener("contextmenu", (e) => e.preventDefault());
  view.addEventListener("dblclick", (e) => {
    if (state.tool === "polygon") { closePolygon(); return; }
    // パペットワープ: ピンをダブルクリックで削除
    if (state.tool === "puppet-warp" && warpSession.active) {
      const s = localPos(e);
      const d = screenToDoc(s.x, s.y);
      const hit = warpSession.pickPin(d, PIN_HIT_RADIUS / state.zoom);
      if (hit) warpSession.deletePin(hit.id);
    }
  });
}
