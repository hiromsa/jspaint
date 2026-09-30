/**
 * scripts/verify-tooltab.ts — ツール選択時の「ツール」タブ自動切替の E2E 検証
 *
 * ① 初期状態は「ツール」タブがアクティブ
 * ② フィルター / レイヤータブ表示中にツールを選ぶと「ツール」タブへ自動復帰する
 *    (ツールボタンの click / キーボードショートカットの両入口)
 * ③ 同じツールの再選択でも「ツール」タブへ復帰する (常時アクティブ化の仕様)
 * ④ ツールタブ表示中のツール切替でタブ状態が壊れない
 * ⑤ タブの手動切替は従来どおり動作する
 *
 * 実行: npm run test:tooltab  (事前に npm run build 必須)
 * ブラウザ: インストール済みの Chrome / Edge を自動検出して使用
 */
import puppeteer, { type Page } from "puppeteer-core";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

/* --- 使用ブラウザの解決 (verify-toolsize.ts と同じ候補) --- */
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

/** アクティブなタブ名 (data-tab) */
async function activeTab(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector<HTMLElement>(".tab.is-active")?.dataset.tab ?? "");
}

/** アクティブなパネルの id */
async function activePanel(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector<HTMLElement>(".panel.is-active")?.id ?? "");
}

/** 選択中ツール名 (#tool-title) */
async function toolTitle(page: Page): Promise<string> {
  return page.evaluate(() => (document.querySelector("#tool-title") as HTMLElement).textContent ?? "");
}

/** タブをクリックして切り替える */
async function clickTab(page: Page, name: string): Promise<void> {
  await page.click(`.tab[data-tab="${name}"]`);
  await new Promise((r) => setTimeout(r, 100));
}

/** ツールを切り替える (ツールボタンの click) */
async function selectTool(page: Page, tool: string): Promise<void> {
  await page.click(`[data-tool="${tool}"]`);
  await new Promise((r) => setTimeout(r, 120));
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

  const browser = await puppeteer.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.goto(pathToFileURL(distFile).href, { waitUntil: "load" });
  await page.waitForSelector("#layer-list li");
  await new Promise((r) => setTimeout(r, 300));

  try {
    /* --- 1) 初期状態 --- */
    ok("起動直後は「ツール」タブがアクティブ", (await activeTab(page)) === "tool");
    ok("起動直後は panel-tool がアクティブ", (await activePanel(page)) === "panel-tool");

    /* --- 2) フィルタータブ中にショートカットでツール選択 → 自動復帰 --- */
    await clickTab(page, "filter");
    ok("フィルタータブへ手動切替できる", (await activeTab(page)) === "filter");
    await page.keyboard.press("e");
    await new Promise((r) => setTimeout(r, 150));
    ok("フィルタータブ中に E キーでツール選択すると「ツール」タブへ自動復帰", (await activeTab(page)) === "tool");
    ok("自動復帰後の表示パネルは panel-tool", (await activePanel(page)) === "panel-tool");
    ok("選択ツールは消しゴム", (await toolTitle(page)) === "消しゴム");

    /* --- 3) レイヤータブ中にツールボタン click → 自動復帰 --- */
    await clickTab(page, "layers");
    ok("レイヤータブへ手動切替できる", (await activeTab(page)) === "layers");
    await selectTool(page, "wand");
    ok("レイヤータブ中に魔法の杖ボタンでツール選択すると「ツール」タブへ自動復帰", (await activeTab(page)) === "tool");
    ok("選択ツールは魔法の杖", (await toolTitle(page)) === "魔法の杖");

    /* --- 4) フィルタータブ中に同じツールを再選択しても復帰する --- */
    await clickTab(page, "filter");
    await page.keyboard.press("e");
    await new Promise((r) => setTimeout(r, 150));
    ok("フィルタータブ中に同じツール (E) を再選択しても「ツール」タブへ復帰", (await activeTab(page)) === "tool");

    /* --- 5) ツールタブ表示中のツール切替でタブ状態は維持 --- */
    await selectTool(page, "bloat");
    ok("ツールタブ中のツール切替では「ツール」タブのまま", (await activeTab(page)) === "tool");
    ok("選択ツールは膨張", (await toolTitle(page)) === "膨張");

    /* --- 6) タブの手動切替は従来どおり動作する --- */
    await clickTab(page, "layers");
    ok("ツール選択後もタブの手動切替は有効 (レイヤー)", (await activeTab(page)) === "layers");
    await clickTab(page, "filter");
    ok("ツール選択後もタブの手動切替は有効 (フィルター)", (await activeTab(page)) === "filter");
    await clickTab(page, "tool");
    ok("ツール選択後もタブの手動切替は有効 (ツール)", (await activeTab(page)) === "tool");

    console.log(`\n結果: ${passed} 合格 / ${failed} 失敗`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
