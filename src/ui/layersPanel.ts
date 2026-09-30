/**
 * ui/layersPanel.ts — レイヤーパネルの描画と配線
 * レイヤー行: サムネイル / 名前 / 編集対象バッジ / ロック切替 / 表示・非表示。
 */
import { mountIcons } from "../assets/icons";
import { doc } from "../core/documentStore";
import { filters } from "../core/filterEngine";
import type { Layer } from "../core/types";
import { drawMaskLayerThumb } from "../rendering/maskDisplay";
import { render } from "../rendering/renderer";
import { $ } from "./dom";

/** サムネイルの辺長 (canvas px。CSS で 34px 表示に縮小される) */
const THUMB_SIZE = 68;

function layerBadgeHTML(l: Layer): string {
  let html = "";
  // 編集対象バッジ (アクティブレイヤー以外の追加対象に表示)
  if (doc.editTargetIds.has(l.id) && l.id !== doc.activeLayerId) {
    html += `<span class="layer__badge layer__badge--target" title="編集対象 (Ctrl+クリックで解除)"><i data-icon="link"></i>編集</span>`;
  }
  // Inpainting マスクレイヤーバッジ (エクスポート時にマスクとして送信されるレイヤー)
  if (doc.isInpaintMaskLayer(l)) {
    html += `<span class="layer__badge layer__badge--mask" title="Inpainting マスクレイヤー (エクスポート時にマスクとして送信 / もう一度下のボタンで解除)"><i data-icon="wand"></i>マスク</span>`;
  }
  if (l.kind === "image") {
    const fxOn = filters.filtersActive() && doc.editTargets().includes(l);
    html += `<span class="layer__badge layer__badge--image" title="元画像レイヤー (編集可)">${fxOn ? '<span class="layer__badge layer__badge--fx">FX</span>' : ""}</span>`;
  }
  return html;
}

export function renderLayers(): void {
  const list = $("#layer-list");
  list.innerHTML = "";
  [...doc.layers].reverse().forEach((l) => {
    const isMask = doc.isInpaintMaskLayer(l);
    const li = document.createElement("li");
    li.className = `layer${l.id === doc.activeLayerId ? " is-active" : ""}${doc.editTargetIds.has(l.id) ? " is-target" : ""}${l.visible ? "" : " is-hidden-layer"}${l.locked ? " is-locked" : ""}${isMask ? " is-mask" : ""}`;
    li.innerHTML = `
      <div class="layer__thumb"></div>
      <div class="layer__meta">
        <div class="layer__name">${l.name} ${layerBadgeHTML(l)}</div>
        <div class="layer__sub">${isMask ? "Inpainting マスク" : l.kind === "image" ? "元画像 · 編集可" : `${doc.width} × ${doc.height} · normal`}</div>
      </div>
      <button class="layer__mask" title="${isMask ? "Inpainting マスクの指定を解除" : "Inpainting マスクレイヤーに指定 (エクスポート時にこのレイヤーがマスクになる / 1 枚のみ指定可)"}"><i data-icon="${isMask ? "check" : "wand"}"></i></button>
      <button class="layer__lock" title="${l.locked ? "ロック解除" : "ロック (描画・フィルターの対象外にする)"}"><i data-icon="${l.locked ? "lock" : "lock-open"}"></i></button>
      <button class="layer__eye" title="表示 / 非表示"><i data-icon="${l.visible ? "eye" : "eye-off"}"></i></button>`;
    // Inpainting マスクレイヤーはキャンバス表示に合わせてドット網掛のサムネイルにする
    const thumb = isMask ? drawMaskLayerThumb(l.canvas, THUMB_SIZE) : cloneThumb(l.canvas);
    (li.querySelector(".layer__thumb") as HTMLElement).appendChild(thumb);
    li.addEventListener("click", (e) => doc.selectLayer(l, e.ctrlKey || e.metaKey || e.shiftKey));
    (li.querySelector(".layer__mask") as HTMLElement).addEventListener("click", (e) => {
      e.stopPropagation();
      // トグル (同時に 1 枚のみ指定可 — 他のレイヤー指定時は付け替え)
      doc.setInpaintMaskLayer(isMask ? null : l);
    });
    (li.querySelector(".layer__lock") as HTMLElement).addEventListener("click", (e) => {
      e.stopPropagation();
      doc.toggleLock(l);
    });
    (li.querySelector(".layer__eye") as HTMLElement).addEventListener("click", (e) => {
      e.stopPropagation();
      l.visible = !l.visible;
      renderLayers();
      render();
    });
    list.appendChild(li);
  });
  mountIcons(list);
  $("#layer-count").textContent = String(doc.layers.length);
  $("#layer-target-count").textContent = String(doc.editTargets().length);
}

function cloneThumb(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = THUMB_SIZE;
  c.height = THUMB_SIZE;
  const g = c.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, THUMB_SIZE, THUMB_SIZE);
  return c;
}

export function bindLayers(): void {
  $("#btn-layer-add").addEventListener("click", () => doc.addLayer());
  $("#btn-layer-dup").addEventListener("click", () => doc.addLayer(doc.activeLayer()));
  $("#btn-layer-del").addEventListener("click", () => doc.deleteActiveLayer());
}