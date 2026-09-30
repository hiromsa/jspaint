/**
 * scripts/verify-toolstack.ts — ツールスタック (階層ボタン) の E2E 検証
 *
 * ① 図形ツール (直線 / 矩形 / 円) が 1 つのツールスタックにまとまっていること
 * ② メインボタンの表示 (data-tool / アイコン / title) が選択中ツールに追従すること
 * ③ ▶ キャレットクリック / メインボタン右クリックでポップを開き、外側クリックで閉じること
 * ④ ポップのボタン / ショートカット (L / U / O) のどちらでも切替できること
 * ⑤ 図形ツール選択時にサイズ行が表示されること (SIZE_TOOLS 連動)
 * ⑥ 回帰: 覆い焼き / 焼き込みスタックが従来どおり動作すること
 *
 * 実行: npm run test:toolstack  (事前に npm run build 必須)
 * ブラウザ: インストール済みの Chrome / Edge を自動検出して使用
 */
import puppeteer, { type Page } from "puppeteer-core";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

/* --- 使用ブラウザの解決 (verify-tooltab.ts と同じ候補) --- */
const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

/** dist/index.html は npm run の実行ディレクトリ (プロジェクトルート) 基準で探す */
const distFile = path.resolve(process.cwd(), "dist", "index.html");

const SHAPE_STACK = '.toolstack[data-stack="line,rect,ellipse"]';
const DODGE_STACK = '.toolstack[data-stack="dodge,burn"]';
/** サイズ行 (index.html の data-show と同じメンバー) */
const SIZE_ROW = '[data-show="brush,eraser,line,rect,ellipse,mask-pen,smudge,bloat,dodge,burn,filter-pen"]';

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

/** スタックのメインボタン状態 (data-tool / title / アイコン SVG の有無) */
async function stackMain(page: Page, sel: string): Promise<{ tool: string; title: string; hasIcon: boolean }> {
  return page.evaluate((s) => {
    const stack = document.querySelector<HTMLElement>(s)!;
    const main = stack.querySelector<HTMLElement>(":scope > .toolbtn")!;
    return { tool: main.dataset.tool ?? "", title: main.title, hasIcon: !!main.querySelector("svg") };
  }, sel);
}

/** スタックのポップが表示中か (hidden 解除 + 実際に display が出ている) */
async function popVisible(page: Page, sel: string): Promise<boolean> {
  return page.evaluate((s) => {
    const pop = document.querySelector<HTMLElement>(`${s} > .toolstack__pop`)!;
    return !pop.hidden && getComputedStyle(pop).display !== "none";
  }, sel);
}

/** 選択中ツール名 (#tool-title) */
async function toolTitle(page: Page): Promise<string> {
  return page.evaluate(() => (document.querySelector("#tool-title") as HTMLElement).textContent ?? "");
}

/** アクティブなタブ名 (data-tab) */
async function activeTab(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector<HTMLElement>(".tab.is-active")?.dataset.tab ?? "");
}

/** サイズ行の表示状態 */
async function isSizeRowVisible(page: Page): Promise<boolean> {
  return page.evaluate((s) => getComputedStyle(document.querySelector(s) as HTMLElement).display !== "none", SIZE_ROW);
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
    /* --- 1) 図形スタックの初期状態 --- */
    ok("図形ツール (line,rect,ellipse) が 1 つのツールスタックにまとまっている", await page.evaluate((s) => !!document.querySelector(s), SHAPE_STACK));
    const init = await stackMain(page, SHAPE_STACK);
    ok("初期状態のメインボタンは直線", init.tool === "line", `tool=${init.tool}`);
    ok("初期状態のメインボタンにアイコン SVG がある", init.hasIcon);
    ok("初期状態のポップは非表示", !(await popVisible(page, SHAPE_STACK)));

    /* --- 2) ▶ キャレットでポップを開く --- */
    await page.click(`${SHAPE_STACK} > .toolstack__caret`);
    await new Promise((r) => setTimeout(r, 120));
    ok("▶ キャレットのクリックでポップが開く", await popVisible(page, SHAPE_STACK));

    /* --- 3) ポップから矩形を選択 --- */
    await page.click(`${SHAPE_STACK} .toolstack__pop [data-tool="rect"]`);
    await new Promise((r) => setTimeout(r, 150));
    ok("ポップで矩形を選ぶと選択ツールが矩形になる", (await toolTitle(page)) === "矩形");
    const rectMain = await stackMain(page, SHAPE_STACK);
    ok("メインボタンの表示が矩形に追従 (data-tool / アイコン)", rectMain.tool === "rect" && rectMain.hasIcon, `tool=${rectMain.tool}`);
    ok("メインボタンの title に「切替」の案内が出る", rectMain.title.includes("切替"), `title=${rectMain.title}`);
    ok("ツール選択で「ツール」タブへ自動切替される", (await activeTab(page)) === "tool");
    ok("選択後の外側クリックでポップが閉じる", !(await popVisible(page, SHAPE_STACK)));

    /* --- 4) ショートカット (O / L) でも切替できメイン表示が追従する --- */
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("o");
    await new Promise((r) => setTimeout(r, 150));
    const ellipseMain = await stackMain(page, SHAPE_STACK);
    ok("O キーで円に切り替わりメイン表示も追従", (await toolTitle(page)) === "円" && ellipseMain.tool === "ellipse", `tool=${ellipseMain.tool}`);
    await page.keyboard.press("l");
    await new Promise((r) => setTimeout(r, 150));
    const lineMain = await stackMain(page, SHAPE_STACK);
    ok("L キーで直線に戻りメイン表示も追従", (await toolTitle(page)) === "直線" && lineMain.tool === "line", `tool=${lineMain.tool}`);

    /* --- 5) メインボタンの右クリックでポップを開き、外側クリックで閉じる --- */
    await page.click(`${SHAPE_STACK} > .toolbtn`, { button: "right" });
    await new Promise((r) => setTimeout(r, 120));
    ok("メインボタンの右クリックでポップが開く", await popVisible(page, SHAPE_STACK));
    await page.mouse.click(700, 24); // ヘッダー (ドキュメント名) の空白部 — 動作を持たない外側クリック
    await new Promise((r) => setTimeout(r, 120));
    ok("外側クリックでポップが閉じる", !(await popVisible(page, SHAPE_STACK)));

    /* --- 6) メインボタン (左クリック) は表示中のツールを選択する --- */
    await page.click(`${SHAPE_STACK} > .toolbtn`);
    await new Promise((r) => setTimeout(r, 150));
    ok("メインボタンの左クリックで表示中の直線を選択する", (await toolTitle(page)) === "直線");
    ok("図形ツール選択中はサイズ行が表示される", await isSizeRowVisible(page));

    /* --- 7) 回帰: 覆い焼き / 焼き込みスタック --- */
    await page.click(`${DODGE_STACK} > .toolstack__caret`);
    await new Promise((r) => setTimeout(r, 120));
    ok("既存スタック (覆い焼き/焼き込み) もポップが開く", await popVisible(page, DODGE_STACK));
    await page.click(`${DODGE_STACK} .toolstack__pop [data-tool="burn"]`);
    await new Promise((r) => setTimeout(r, 150));
    const burnMain = await stackMain(page, DODGE_STACK);
    ok("焼き込みを選ぶとメイン表示が追従する", (await toolTitle(page)) === "焼き込み" && burnMain.tool === "burn", `tool=${burnMain.tool}`);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("d");
    await new Promise((r) => setTimeout(r, 150));
    const dodgeMain = await stackMain(page, DODGE_STACK);
    ok("D キーで覆い焼きに戻りメイン表示も追従する", (await toolTitle(page)) === "覆い焼き" && dodgeMain.tool === "dodge", `tool=${dodgeMain.tool}`);

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
