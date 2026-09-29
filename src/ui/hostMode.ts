/**
 * ui/hostMode.ts — ホスト (親アプリ) 連携モードの判定と UI 出し分け
 *
 * 呼び出され方に応じて「単体で使う機能」(ファイルを開く / 保存) と
 * 「親アプリ連携機能」(postMessage / クリップボード) を切り替える。
 *
 * - URL パラメータ `?mode=embed` / `?mode=standalone` で明示指定できる
 * - 未指定の場合は iframe 内なら embed、そうでなければ standalone と判定する
 * - embed 時は `data-standalone-only` 属性を持つ要素が CSS で非表示になる
 */
export type HostMode = "standalone" | "embed";

/** ホストモードを判定する (URL パラメータ優先 → iframe 有無で自動判定) */
export function detectHostMode(): HostMode {
  const q = new URLSearchParams(location.search).get("mode");
  if (q === "embed") return "embed";
  if (q === "standalone") return "standalone";
  return window.parent !== window ? "embed" : "standalone";
}

/** アプリ全体で共有するホストモード (起動時に一度だけ判定) */
export const hostMode: HostMode = detectHostMode();

/** <html data-host-mode="..."> を設定し、CSS 側の表示切替を有効にする */
export function applyHostModeUI(): void {
  document.documentElement.dataset.hostMode = hostMode;
}