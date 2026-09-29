/**
 * ui/layersPanel.ts — レイヤーパネルの描画と配線
 * レイヤー行: サムネイル / 名前 / 編集対象バッジ / ロック切替 / 表示・非表示。
 */
import { mountIcons } from "../assets/icons";
import { doc } from "../core/documentStore";
import { filters } from "../core/filterEngine";
import type { Layer } from "../core/types";
import { render } from "../rendering/renderer";
import { $ } from "./dom";

function layerBadgeHTML(l: Layer): string {
  let html = "";
  // 編集対象バッジ (アクティブレイヤー以外の追加対象に表示)
  if (doc.editTargetIds.has(l.id) && l.id !== doc.activeLayerId) {
    html += `<span class="layer__badge layer__badge--target" title="編集対象 (Ctrl+クリックで解除)"><i data-icon="link"></i>編集</span>`;
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
    const li = document.createElement("li");
    li.className = `layer${l.id === doc.activeLayerId ? " is-active" : ""}${doc.editTargetIds.has(l.id) ? " is-target" : ""}${l.visible ? "" : " is-hidden-layer"}${l.locked ? " is-locked" : ""}`;
    li.innerHTML = `
      <div class="layer__thumb"></div>
      <div class="layer__meta">
        <div class="layer__name">${l.name} ${layerBadgeHTML(l)}</div>
        <div class="layer__sub">${l.kind === "image" ? "元画像 · 編集可" : `${doc.width} × ${doc.height} · normal`}</div>
      </div>
      <button class="layer__lock" title="${l.locked ? "ロック解除" : "ロック (描画・フィルターの対象外にする)"}"><i data-icon="${l.locked ? "lock" : "lock-open"}"></i></button>
      <button class="layer__eye" title="表示 / 非表示"><i data-icon="${l.visible ? "eye" : "eye-off"}"></i></button>`;
    (li.querySelector(".layer__thumb") as HTMLElement).appendChild(cloneThumb(l.canvas));
    li.addEventListener("click", (e) => doc.selectLayer(l, e.ctrlKey || e.metaKey || e.shiftKey));
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
  c.width = 68;
  c.height = 68;
  const g = c.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, 68, 68);
  return c;
}

export function bindLayers(): void {
  $("#btn-layer-add").addEventListener("click", () => doc.addLayer());
  $("#btn-layer-dup").addEventListener("click", () => doc.addLayer(doc.activeLayer()));
  $("#btn-layer-del").addEventListener("click", () => doc.deleteActiveLayer());
}