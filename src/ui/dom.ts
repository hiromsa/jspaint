/**
 * ui/dom.ts — DOM 取得と共通 UI 操作の最小ユーティリティ
 */
export const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
export const $$ = <T extends HTMLElement>(sel: string) => Array.from(document.querySelectorAll(sel)) as T[];

/** range スライダーの塗り位置 (--fill CSS 変数) を更新 */
export function paintRangeFill(el: HTMLInputElement): void {
  const min = Number(el.min);
  const max = Number(el.max);
  el.style.setProperty("--fill", `${((Number(el.value) - min) / (max - min)) * 100}%`);
}