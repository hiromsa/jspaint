/**
 * scripts/verify-imageio.ts — 画像入出力 (開く / 保存 / コピー / ペースト / ドロップ) と
 * ホストモード (standalone / embed) のヘッドレス E2E 検証。
 *
 * 実行: npm run test:imageio  (事前に npm run build が必要)
 * ブラウザ: インストール済みの Chrome / Edge を自動検出して使用 (追加ダウンロード不要)
 */
import puppeteer, { type Page } from "puppeteer-core";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

/* --- 使用ブラウザの候補 (順に検索し、最初に存在したものを使う) --- */
const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

/** dist/index.html は npm run の実行ディレクトリ (プロジェクトルート) 基準で探す */
const distFile = path.resolve(process.cwd(), "dist", "index.html");

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function warn(name: string, detail: string): void {
  console.log(`  WARN ${name} — ${detail}`);
}

/** ページ内で w×h のグラデーション画像を生成し、paste / drop イベントとして流し込む */
async function injectImage(page: Page, mode: "paste" | "drop", w: number, h: number, name: string): Promise<void> {
  await page.evaluate(async (m, w, h, name) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, "#ff0000");
    grad.addColorStop(1, "#0000ff");
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], name, { type: "image/png" }));
    if (m === "paste") {
      const ev = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "clipboardData", { value: dt });
      document.dispatchEvent(ev);
    } else {
      const ev = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", { value: dt });
      document.querySelector("#workspace")!.dispatchEvent(ev);
    }
  }, mode, w, h, name);
}

/** ドキュメント情報表示が指定サイズになるまで待ち、内容を取得する */
async function waitDocInfo(page: Page, dim: string): Promise<{ name: string; dim: string; status: string }> {
  await page.waitForFunction(
    (dim) => (document.querySelector("#doc-dim") as HTMLElement).textContent === dim,
    {},
    dim,
  );
  return page.evaluate(() => ({
    name: (document.querySelector("#doc-name") as HTMLElement).textContent ?? "",
    dim: (document.querySelector("#doc-dim") as HTMLElement).textContent ?? "",
    status: (document.querySelector("#doc-status") as HTMLElement).textContent ?? "",
  }));
}

/** 直近の toast メッセージ全文を取得する */
async function lastToast(page: Page): Promise<string> {
  return page.evaluate(() => {
    const toasts = document.querySelectorAll("#toasts .toast");
    return toasts.length ? (toasts[toasts.length - 1] as HTMLElement).textContent ?? "" : "";
  });
}

/** 背景レイヤーのサムネイル中央の色を取得する */
async function baseThumbCenterColor(page: Page): Promise<[number, number, number]> {
  return page.evaluate(() => {
    const items = document.querySelectorAll("#layer-list li");
    const thumb = items[items.length - 1].querySelector("canvas")!;
    const d = thumb.getContext("2d")!.getImageData(34, 34, 1, 1).data;
    return [d[0], d[1], d[2]];
  });
}

async function sendCtrlKey(page: Page, key: string, shift = false): Promise<void> {
  await page.keyboard.down("Control");
  if (shift) await page.keyboard.down("Shift");
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
}

async function main(): Promise<void> {
  if (!existsSync(distFile)) {
    console.error("dist/index.html がありません。先に `npm run build` を実行してください。");
    process.exit(1);
  }
  const executablePath = BROWSER_CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) {
    console.error("Chrome / Edge が見つかりませんでした。");
    process.exit(1);
  }
  const fileUrl = pathToFileURL(distFile).href;
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-first-run"] });

  try {
    /* ========== 1) standalone モード (既定) ========== */
    console.log("\n[standalone]");
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${fileUrl}?mode=standalone`);
    await page.waitForSelector("#layer-list li");

    ok("html[data-host-mode=standalone]", await page.evaluate(() => document.documentElement.dataset.hostMode === "standalone"));
    ok("開く/保存/コピーボタンが表示される", await page.evaluate(() =>
      ["#btn-open", "#btn-save", "#btn-copy"].every((s) => (document.querySelector(s) as HTMLElement).offsetParent !== null),
    ));
    const init = await waitDocInfo(page, "640×640");
    ok("初期ドキュメント 640×640 / sample_photo.png", init.name === "sample_photo.png", `name=${init.name}`);

    /* --- 2) ペースト (Ctrl+V 相当) → ドキュメントが画像サイズへ追従 --- */
    await injectImage(page, "paste", 320, 200, "pasted.png");
    const pasted = await waitDocInfo(page, "320×200");
    ok("ペーストでドキュメントが 320×200 に変化", pasted.dim === "320×200", `dim=${pasted.dim}`);
    ok("ペーストではドキュメント名が clipboard.png になる", pasted.name === "clipboard.png", `name=${pasted.name}`);
    ok("貼り付け後は READY 表示に戻る", pasted.status === "READY", `status=${pasted.status}`);
    ok("貼り付け後に Undo 履歴はクリアされる", await page.evaluate(() => (document.querySelector("#btn-undo") as HTMLButtonElement).disabled));
    const zoom = await page.evaluate(() => (document.querySelector("#btn-zoom-label") as HTMLElement).textContent);
    ok("読み込み後に画面フィットされる", zoom !== "100%", `zoom=${zoom}`);
    const [r, g, b] = await baseThumbCenterColor(page);
    ok("背景レイヤーに貼り付け画像が反映される", Math.abs(r - 128) < 36 && g < 40 && Math.abs(b - 128) < 36, `rgb(${r},${g},${b})`);

    /* --- 3) ドラッグ & ドロップ --- */
    await injectImage(page, "drop", 256, 128, "dropped.png");
    const dropped = await waitDocInfo(page, "256×128");
    ok("ドロップでドキュメントが 256×128 に変化", dropped.dim === "256×128", `dim=${dropped.dim}`);
    ok("ドロップでドキュメント名が更新される", dropped.name === "dropped.png", `name=${dropped.name}`);

    /* --- 4) 保存 (Ctrl+S) --- */
    await sendCtrlKey(page, "s");
    await new Promise((res) => setTimeout(res, 150));
    const saveToast = await lastToast(page);
    ok("Ctrl+S で合成画像を保存", saveToast.includes("を保存しました"), `toast="${saveToast}"`);

    /* --- 5) クリップボードコピー (Ctrl+Shift+C / ボタン) --- */
    await sendCtrlKey(page, "c", true);
    await new Promise((res) => setTimeout(res, 250));
    const copyToast = await lastToast(page);
    if (copyToast.includes("コピーしました")) {
      ok("合成画像をクリップボードへコピー", true);
    } else {
      warn("合成画像をクリップボードへコピー", `toast="${copyToast}" (ヘッドレス環境で clipboard API が制限される場合あり)`);
    }
    await page.click("#btn-copy");
    await new Promise((res) => setTimeout(res, 250));
    const copyBtnToast = await lastToast(page);
    ok("コピーボタンでもコピー動作 (toast 応答)", copyBtnToast.includes("クリップボード"), `toast="${copyBtnToast}"`);

    /* ========== 6) embed モード (親アプリ埋め込みを想定) ========== */
    console.log("\n[embed]");
    const page2 = await browser.newPage();
    await page2.setViewport({ width: 1280, height: 800 });
    await page2.goto(`${fileUrl}?mode=embed`);
    await page2.waitForSelector("#layer-list li");

    ok("html[data-host-mode=embed]", await page2.evaluate(() => document.documentElement.dataset.hostMode === "embed"));
    ok("開く/保存ボタンは非表示", await page2.evaluate(() =>
      ["#btn-open", "#btn-save"].every((s) => getComputedStyle(document.querySelector(s) as HTMLElement).display === "none"),
    ));
    ok("コピーボタンは表示される", await page2.evaluate(() => (document.querySelector("#btn-copy") as HTMLElement).offsetParent !== null));

    /* --- 7) embed でもペースト / コピーは利用可 --- */
    await injectImage(page2, "paste", 128, 64, "embed.png");
    const embedPaste = await waitDocInfo(page2, "128×64");
    ok("embed でもペーストで画像を読み込める", embedPaste.dim === "128×64", `dim=${embedPaste.dim}`);

    await sendCtrlKey(page2, "s");
    await new Promise((res) => setTimeout(res, 150));
    const embedSaveToast = await lastToast(page2);
    ok("embed で Ctrl+S は「完了」で返すよう案内", embedSaveToast.includes("埋め込みモード"), `toast="${embedSaveToast}"`);
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
