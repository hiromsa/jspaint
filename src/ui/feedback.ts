/**
 * ui/feedback.ts — ユーザーへのフィードバック表示 (Toast / 未保存ドット)
 * core (ロジック) からは hooks 経由で呼ばれる。
 */
import { state } from "../core/editorState";
import { $ } from "./dom";

export function toast(msg: string, kind: "info" | "ok" | "fx" = "info"): void {
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.classList.add("is-out"), 2200);
  setTimeout(() => el.remove(), 2500);
}

/** 最初の編集操作でヘッダーのドキュメント状態を「EDITING」に変える */
export function markDirty(): void {
  if (state.dirty) return;
  state.dirty = true;
  $("#doc-dot").classList.add("doc-dot--editing");
  const st = $("#doc-status");
  st.textContent = "EDITING";
  st.classList.remove("doc-status--ready");
  st.classList.add("doc-status--editing");
}