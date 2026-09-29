/**
 * ui/filtersPanel.ts — Inpainting 前処理フィルタータブの配線と同期
 */
import { filters } from "../core/filterEngine";
import { $, $$, paintRangeFill } from "./dom";
import { markDirty, toast } from "./feedback";
import { render } from "../rendering/renderer";

const FX_FORMAT: Record<string, (v: number) => string> = {
  blur: (v) => `${v.toFixed(1)} px`,
  noise: (v) => `${Math.round(v)} %`,
  brightness: (v) => `${Math.round(v)} %`,
  contrast: (v) => `${Math.round(v)} %`,
  saturate: (v) => `${Math.round(v)} %`,
  hue: (v) => `${Math.round(v)}°`,
};

export function syncFilterUI(): void {
  // フィルターエンジンの数値フィールドへキー文字列でアクセスするためのビュー
  const numeric = filters as unknown as Record<string, number>;
  for (const key of Object.keys(filters.on)) {
    const box = $(`input[data-fx-on="${key}"]`) as HTMLInputElement;
    const range = $(`input[data-fx-range="${key}"]`) as HTMLInputElement;
    const val = $(`[data-fx-val="${key}"]`);
    box.checked = filters.on[key];
    range.value = String(numeric[key]);
    paintRangeFill(range);
    val.textContent = FX_FORMAT[key](numeric[key]);
    ($(`.fx[data-fx="${key}"]`) as HTMLElement).classList.toggle("is-on", filters.on[key]);
  }
  // ノイズの種類 (カラー / グレー) ボタンの反映
  $$("button[data-fx-noise-mode]").forEach((b) =>
    b.classList.toggle("is-active", (b as HTMLElement).dataset.fxNoiseMode === filters.noiseMode),
  );
}

export function bindFilters(): void {
  $$("input[data-fx-on]").forEach((el) =>
    el.addEventListener("change", () => {
      const key = (el as HTMLElement).dataset.fxOn!;
      filters.on[key] = (el as HTMLInputElement).checked;
      syncFilterUI();
      markDirty();
      render();
    }),
  );

  $$("input[data-fx-range]").forEach((el) =>
    el.addEventListener("input", () => {
      const key = (el as HTMLElement).dataset.fxRange!;
      (filters as unknown as Record<string, number>)[key] = Number((el as HTMLInputElement).value);
      syncFilterUI();
      if (filters.on[key]) { markDirty(); render(); }
    }),
  );
  // ノイズの種類 (カラー / グレー)
  $$("button[data-fx-noise-mode]").forEach((btn) =>
    btn.addEventListener("click", () => {
      filters.noiseMode = (btn as HTMLElement).dataset.fxNoiseMode as "color" | "gray";
      syncFilterUI();
      if (filters.on.noise) {
        markDirty();
        render();
      }
    }),
  );
  // フィルターの確定(ベイク) / リセット
  $("#btn-filter-apply").addEventListener("click", () => filters.bake());
  $("#btn-filter-reset").addEventListener("click", () => {
    filters.resetValues();
    syncFilterUI();
    render();
    toast("フィルターをリセット", "fx");
  });
}