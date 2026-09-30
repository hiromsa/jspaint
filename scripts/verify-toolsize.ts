/**
 * scripts/verify-toolsize.ts — ブラシサイズ上限拡張 (500px) とツール別サイズ保存の E2E 検証
 *
 * ① スライダー上限が 500px であること (HTML と core 定数の同期)
 * ② ツールごとにサイズが独立して記憶され、切替時に復元されること
 * ③ [ ] キーでのサイズ変更が上限 500 にクランプされること
 * ④ localStorage へ永続化され、リロード後も復元されること
 * ⑤ 壊れた localStorage データでも既定値で起動すること (クラッシュしない)
 *
 * 実行: npm run test:toolsize  (事前に npm run build 必須)
 * ブラウザ: インストール済みの Chrome / Edge を自動検出して使用
 */
import puppeteer, { type Page } from "puppeteer-core";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

/* --- 使用ブラウザの解決 (verify-imageio.ts と同じ候補) --- */
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

/** サイズスライダーの現在値 (input 要素の value) */
async function getSize(page: Page): Promise<number> {
  return page.evaluate(() => Number((document.querySelector<HTMLInputElement>("#ctl-size")!).value));
}

/** サイズの表示ラベル (#ctl-size-val) */
async function getSizeLabel(page: Page): Promise<string> {
  return page.evaluate(() => (document.querySelector("#ctl-size-val") as HTMLElement).textContent ?? "");
}

/** UI 経由でサイズを変更する (スライダーの input イベントを発火) */
async function setSize(page: Page, value: number): Promise<void> {
  await page.evaluate((v) => {
    const el = document.querySelector<HTMLInputElement>("#ctl-size")!;
    el.value = String(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

/** localStorage に保存されたツール別サイズ */
async function storedSizes(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("jspaint.toolSizes.v1") ?? "{}") as Record<string, number>;
    } catch {
      return {};
    }
  });
}

/** ツールを切り替える (ツールボタンの click) */
async function selectTool(page: Page, tool: string): Promise<void> {
  await page.click(`[data-tool="${tool}"]`);
  await new Promise((r) => setTimeout(r, 120));
}

/** ページを再読み込みして起動完了を待つ */
async function reload(page: Page, fileUrl: string): Promise<void> {
  await page.goto(fileUrl, { waitUntil: "load" });
  await page.waitForSelector("#layer-list li");
  await new Promise((r) => setTimeout(r, 300));
}

/** サイズ行 (data-show 持つ ctrl) の表示状態 */
async function isSizeRowVisible(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    getComputedStyle(document.querySelector('[data-show="brush,eraser,line,rect,ellipse,mask-pen,smudge,bloat,dodge,burn,filter-pen"]') as HTMLElement).display !== "none",
  );
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
  const page = await browser.newPage();

  try {
    await runTests(page, fileUrl);
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

async function runTests(page: Page, fileUrl: string): Promise<void> {
  console.log("\n[tool-size]");
  page.on("pageerror", (err) => console.log(`  [pageerror] ${err.message}`));
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(fileUrl, { waitUntil: "load" });
  // 既存の保存データに左右されないようクリーンな状態から始める
  await page.evaluate(() => localStorage.clear());
  await reload(page, fileUrl);

  /* --- 1) スライダー上限 (HTML と core 定数の同期) --- */
  ok("サイズスライダーの上限が 500px (MAX_BRUSH_SIZE と同期)", await page.evaluate(() =>
    Number((document.querySelector<HTMLInputElement>("#ctl-size")!).max) === 500,
  ));

  /* --- 2) ブラシで 300px に設定 → 表示と localStorage への保存 --- */
  await setSize(page, 300);
  ok("ブラシのサイズを 300px に設定できる (200px 制限の撤廃)", (await getSize(page)) === 300);
  ok("サイズ表示も 300px に更新される", (await getSizeLabel(page)) === "300 px");
  ok("localStorage に brush=300 が保存される", (await storedSizes(page)).brush === 300);

  /* --- 3) [ ] キーでの増加と上限 500 へのクランプ --- */
  // 300 → 345 → 397 → 457 (3回) → 526→500 (4回目でクランプ) → 500 のまま
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < 3; i++) await page.keyboard.press("]");
  ok("] キーでサイズが段階的に増加する (3回で 457px)", (await getSize(page)) === 457, `size=${await getSize(page)}`);
  await page.keyboard.press("]");
  ok("] キーの増加は上限 500px でクランプされる", (await getSize(page)) === 500, `size=${await getSize(page)}`);
  await page.keyboard.press("]");
  ok("上限到達後に ] を押しても 500px のまま", (await getSize(page)) === 500);
  ok("上限値も localStorage に反映される", (await storedSizes(page)).brush === 500);

  /* --- 4) ツール別のサイズ記憶と切替時の復元 --- */
  await selectTool(page, "bloat");
  ok("膨張 (未記録) への切替時は既定 24px に戻る", (await getSize(page)) === 24, `size=${await getSize(page)}`);
  await setSize(page, 480);
  ok("膨張のサイズを 480px に設定できる", (await getSize(page)) === 480);
  ok("localStorage に bloat=480 が保存される", (await storedSizes(page)).bloat === 480);
  await selectTool(page, "brush");
  ok("ブラシへ戻ると 500px に復元される", (await getSize(page)) === 500, `size=${await getSize(page)}`);
  await selectTool(page, "bloat");
  ok("膨張へ戻ると 480px に復元される", (await getSize(page)) === 480, `size=${await getSize(page)}`);

  /* --- 5) サイズUIを持たないツールではスライダー行を非表示にする --- */
  await selectTool(page, "bucket");
  ok("塗りつぶし選択時はサイズ行が非表示", !(await isSizeRowVisible(page)));
  await selectTool(page, "brush");
  ok("ブラシへ戻るとサイズ行が再表示され値は 500px のまま", (await isSizeRowVisible(page)) && (await getSize(page)) === 500);

  /* --- 6) リロード後も localStorage からツール別サイズが復元される --- */
  await reload(page, fileUrl);
  ok("リロード後: ブラシの 500px が復元される", (await getSize(page)) === 500, `size=${await getSize(page)}`);
  await selectTool(page, "bloat");
  ok("リロード後: 膨張の 480px が復元される", (await getSize(page)) === 480, `size=${await getSize(page)}`);

  /* --- 7) クイックサイズチップもツール別に記憶する --- */
  await selectTool(page, "brush");
  await page.click('.chip[data-size="4"]');
  await new Promise((r) => setTimeout(r, 100));
  ok("クイックサイズ (4px) をクリックするとサイズが変わる", (await getSize(page)) === 4);
  ok("クイックサイズも localStorage に保存される", (await storedSizes(page)).brush === 4);
  await selectTool(page, "bloat");
  ok("チップ変更後も膨張の 480px は保持される", (await getSize(page)) === 480);

  /* --- 8) 壊れた localStorage データへの耐性 --- */
  await page.evaluate(() => localStorage.setItem("jspaint.toolSizes.v1", "not-json{{{"));
  await reload(page, fileUrl);
  ok("保存データが壊れていても既定 24px で起動する", (await getSize(page)) === 24, `size=${await getSize(page)}`);
  ok("壊れたデータがある状態でもサイズ変更・保存が機能する", await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>("#ctl-size")!;
    el.value = "128";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    try {
      return JSON.parse(localStorage.getItem("jspaint.toolSizes.v1") ?? "{}").brush === 128;
    } catch {
      return false;
    }
  }));
}

main();

