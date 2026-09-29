/**
 * ui/filtersPanel.ts — フィルター設定 UI の配線と同期
 * 同一構造の data-fx-* 属性を持つ UI を data-fx-scope コンテナ単位で共通実装により bind / sync する。
 * - image: フィルタータブ (画像全体への適用 / FilterEngine)
 * - pen:   ツールタブの「フィルター効果」(フィルターペン専用 / filterPenFx)
 */
import { filterPenFx, filters } from "../core/filterEngine";
import type { FilterSettings } from "../core/filterEngine";
import { $, paintRangeFill } from "./dom";
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

/** fx UI を持つスコープコンテナ (index.html 側の data-fx-scope 属性と対応) */
function fxScope(name: "image" | "pen"): HTMLElement {
  return $(`[data-fx-scope="${name}"]`);
}

/** スコープ内の fx UI を settings の現在値へ同期 (スコープに存在しないキーの UI は無視) */
function syncFxScope(scope: HTMLElement, settings: FilterSettings): void {
  // フィルター設定の数値フィールドへキー文字列でアクセスするためのビュー
  const numeric = settings as unknown as Record<string, number>;
  for (const key of Object.keys(settings.on)) {
    const box = scope.querySelector<HTMLInputElement>(`input[data-fx-on="${key}"]`);
    const range = scope.querySelector<HTMLInputElement>(`input[data-fx-range="${key}"]`);
    const val = scope.querySelector<HTMLElement>(`[data-fx-val="${key}"]`);
    const fx = scope.querySelector<HTMLElement>(`.fx[data-fx="${key}"]`);
    if (!box || !range || !val || !fx) continue;
    box.checked = settings.on[key];
    range.value = String(numeric[key]);
    paintRangeFill(range);
    val.textContent = FX_FORMAT[key](numeric[key]);
    fx.classList.toggle("is-on", settings.on[key]);
  }
  // ノイズの種類 (カラー / グレー) ボタンの反映
  scope.querySelectorAll("button[data-fx-noise-mode]").forEach((b) =>
    b.classList.toggle("is-active", (b as HTMLElement).dataset.fxNoiseMode === settings.noiseMode),
  );
}

/** 両スコープ (フィルタータブ / フィルターペン) の UI を現在の設定へ同期 */
export function syncFilterUI(): void {
  syncFxScope(fxScope("image"), filters);
  syncFxScope(fxScope("pen"), filterPenFx);
}

/**
 * スコープ内の fx UI 入力を settings へ bind する。
 * onChange(key) で値変更後の追加処理 (プレビュー再描画など) をスコープごとに差し込める。
 */
function bindFxScope(scope: HTMLElement, settings: FilterSettings, onChange?: (key: string) => void): void {
  scope.querySelectorAll<HTMLInputElement>("input[data-fx-on]").forEach((el) =>
    el.addEventListener("change", () => {
      const key = (el as HTMLElement).dataset.fxOn!;
      settings.on[key] = el.checked;
      syncFxScope(scope, settings);
      onChange?.(key);
    }),
  );

  scope.querySelectorAll<HTMLInputElement>("input[data-fx-range]").forEach((el) =>
    el.addEventListener("input", () => {
      const key = (el as HTMLElement).dataset.fxRange!;
      (settings as unknown as Record<string, number>)[key] = Number(el.value);
      syncFxScope(scope, settings);
      onChange?.(key);
    }),
  );
  // ノイズの種類 (カラー / グレー)
  scope.querySelectorAll<HTMLButtonElement>("button[data-fx-noise-mode]").forEach((btn) =>
    btn.addEventListener("click", () => {
      settings.noiseMode = (btn as HTMLElement).dataset.fxNoiseMode as "color" | "gray";
      syncFxScope(scope, settings);
      onChange?.("noise");
    }),
  );
}

export function bindFilters(): void {
  // フィルタータブ (全体適用): 有効なフィルターはキャンバスのプレビュー表示に影響するため再描画する
  bindFxScope(fxScope("image"), filters, (key) => {
    if (filters.on[key]) markDirty();
    render();
  });
  // ツールタブのフィルター効果 (フィルターペン専用): 焼き込み型のためプレビュー更新は不要
  // (変更内容は次のストロークから反映される)
  bindFxScope(fxScope("pen"), filterPenFx);

  // フィルターの確定(ベイク) / リセット
  $("#btn-filter-apply").addEventListener("click", () => filters.bake());
  $("#btn-filter-reset").addEventListener("click", () => {
    filters.resetValues();
    syncFilterUI();
    render();
    toast("フィルターをリセット", "fx");
  });
}