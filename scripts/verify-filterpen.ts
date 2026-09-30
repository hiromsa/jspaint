/**
 * scripts/verify-filterpen.ts — フィルターペン専用フィルター設定 (ツールタブ) の E2E 検証
 *
 * フィルターペン (F) の「フィルター効果」設定がフィルタータブ (全体フィルター) と
 * 独立していること (ペン使用中も画像全体に影響しないこと) を実ブラウザで検証する。
 *
 * 実行: npm run test:filterpen  (事前に npm run build 必須)
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

/** 直近の toast メッセージ全文を取得する */
async function lastToast(page: Page): Promise<string> {
  return page.evaluate(() => {
    const toasts = document.querySelectorAll("#toasts .toast");
    return toasts.length ? (toasts[toasts.length - 1] as HTMLElement).textContent ?? "" : "";
  });
}

/** 指定スコープのフィルターの ON/OFF と強度を UI 経由で設定する */
async function setFx(page: Page, scope: "image" | "pen", key: string, on: boolean, value?: number): Promise<void> {
  await page.evaluate((scope, key, on, value) => {
    const root = document.querySelector(`[data-fx-scope="${scope}"]`)!;
    const box = root.querySelector<HTMLInputElement>(`input[data-fx-on="${key}"]`)!;
    if (box.checked !== on) {
      box.checked = on;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (value !== undefined) {
      const range = root.querySelector<HTMLInputElement>(`input[data-fx-range="${key}"]`)!;
      range.value = String(value);
      range.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, scope, key, on, value);
}

/** 指定スコープのフィルターの ON 状態を取得する */
async function isFxOn(page: Page, scope: "image" | "pen", key: string): Promise<boolean> {
  return page.evaluate((scope, key) =>
    (document.querySelector(`[data-fx-scope="${scope}"] input[data-fx-on="${key}"]`) as HTMLInputElement).checked,
  scope, key);
}

/**
 * #view 上のドキュメント中心基準オフセット (画面px) の 1px の色を取得する。
 * fit 状態では view の中心 = ドキュメント中心。カーソル等のオーバーレイを
 * 消すため、カーソルを view 外へ退避させてから読む。
 */
async function viewPixel(page: Page, dx: number, dy: number): Promise<[number, number, number]> {
  const box = (await (await page.$("#view")).boundingBox())!;
  await page.mouse.move(box.x - 40, box.y - 40);
  await new Promise((r) => setTimeout(r, 120));
  return page.evaluate((dx, dy) => {
    const view = document.querySelector("#view") as HTMLCanvasElement;
    const g = view.getContext("2d")!;
    const d = g.getImageData(Math.round(view.width / 2) + dx, Math.round(view.height / 2) + dy, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, dx, dy);
}

function colorDiff(a: [number, number, number], b: [number, number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
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
    console.log("\n[filter-pen]");
    const page = await browser.newPage();
    page.on("console", (msg) => console.log(`  [browser] ${msg.text()}`));
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${fileUrl}?mode=standalone`);
    await page.waitForSelector("#layer-list li");
    await new Promise((r) => setTimeout(r, 300));

    // view 中央 = ドキュメント中心 (fit 表示)
    const box = (await (await page.$("#view")).boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // サンプル点: 経路上 (中心から右 40px) / 経路外 (中心から上 250px)
    const ON_PATH: [number, number] = [40, 0];
    const OFF_PATH: [number, number] = [0, -250];

    /* --- 1) フィルターペンへの切替とスコープの独立 --- */
    await page.click('[data-tool="filter-pen"]');
    await new Promise((r) => setTimeout(r, 150));
    ok("フィルターペンに切替するとツールタブに専用設定が出る", await page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-fx-scope="pen"]') as HTMLElement).display !== "none",
    ));

    const beforePath = await viewPixel(page, ON_PATH[0], ON_PATH[1]);
    const beforeOutside = await viewPixel(page, OFF_PATH[0], OFF_PATH[1]);

    await setFx(page, "pen", "brightness", true, 150);
    ok("ツールタブの「フィルター効果」を ON にできる", await isFxOn(page, "pen", "brightness"));
    ok("フィルタータブ (全体フィルター) の設定は影響を受けない (独立)", !(await isFxOn(page, "image", "brightness")));
    const penOnOutside = await viewPixel(page, OFF_PATH[0], OFF_PATH[1]);
    ok("ペン用フィルターを有効にしてもキャンバス全体は変化しない", colorDiff(beforeOutside, penOnOutside) < 6);

    // スライダー操作は有効化の意思表示としてスイッチを自動 ON にする (ペン用)
    await page.evaluate(() => {
      const range = document.querySelector('[data-fx-scope="pen"] input[data-fx-range="contrast"]') as HTMLInputElement;
      range.value = "130";
      range.dispatchEvent(new Event("input", { bubbles: true }));
    });
    ok("ペン用: スライダーをドラッグするとスイッチが自動で ON になる", await isFxOn(page, "pen", "contrast"));

    /* --- 2) なぞった範囲だけ焼き込まれる --- */
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy, { steps: 12 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 150));

    const afterPath = await viewPixel(page, ON_PATH[0], ON_PATH[1]);
    const afterOutside = await viewPixel(page, OFF_PATH[0], OFF_PATH[1]);
    const pathDiff = colorDiff(beforePath, afterPath);
    ok("なぞった範囲にフィルター効果が焼き込まれる", pathDiff > 30, `diff=${pathDiff}`);
    const outsideDiff = colorDiff(beforeOutside, afterOutside);
    ok("なぞっていない範囲は変化しない (範囲限定・全体適用されない)", outsideDiff < 6, `diff=${outsideDiff}`);

    /* --- 3) フィルタータブ (全体フィルター) はペンと独立して従来どおり機能する --- */
    await setFx(page, "image", "brightness", true, 150);
    ok("フィルタータブを ON してもペン用設定は保持される", await isFxOn(page, "pen", "brightness"));
    const fullPreview = await viewPixel(page, OFF_PATH[0], OFF_PATH[1]);
    const previewDiff = colorDiff(afterOutside, fullPreview);
    ok("フィルタータブは画像全体へのプレビューとして機能する (従来機能)", previewDiff > 30, `diff=${previewDiff}`);
    await setFx(page, "image", "brightness", false);
    const previewOff = await viewPixel(page, OFF_PATH[0], OFF_PATH[1]);
    ok("フィルタータブを OFF にするとプレビューは元に戻る (非破壊)", colorDiff(afterOutside, previewOff) < 6);

    // スライダー操作でスイッチが自動 ON になる (フィルタータブ)
    await page.evaluate(() => {
      const range = document.querySelector('[data-fx-scope="image"] input[data-fx-range="contrast"]') as HTMLInputElement;
      range.value = "130";
      range.dispatchEvent(new Event("input", { bubbles: true }));
    });
    ok("フィルタータブ: スライダーをドラッグするとスイッチが自動で ON になる", await isFxOn(page, "image", "contrast"));
    await setFx(page, "image", "contrast", false);
    // ノイズの種類 (カラー / グレー) ボタンもノイズ有効の意思表示としてスイッチを自動 ON にする
    await page.evaluate(() => {
      (document.querySelector('[data-fx-scope="image"] button[data-fx-noise-mode="gray"]') as HTMLButtonElement).click();
    });
    ok("フィルタータブ: ノイズの種類ボタンでもスイッチが自動で ON になる", await isFxOn(page, "image", "noise"));
    await setFx(page, "image", "noise", false);

    /* --- 4) フィルター効果が無効なときのストロークは案内表示になる --- */
    await setFx(page, "pen", "brightness", false);
    await setFx(page, "pen", "contrast", false);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy, { steps: 8 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 150));
    const toast = await lastToast(page);
    ok("フィルター効果が無効なときはツールタブでの有効化を案内する", toast.includes("ツールタブ"), `toast="${toast}"`);

    /* --- 5) フィルター効果セクションの表示はフィルターペン選択時に限る --- */
    await page.click('[data-tool="brush"]');
    await new Promise((r) => setTimeout(r, 150));
    ok("他のツール選択時はフィルター効果セクションを非表示にする", await page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-fx-scope="pen"]') as HTMLElement).display === "none",
    ));
    ok("他のツール選択時は他ツール用の説明文 (fx-desc) も非表示になる", await page.evaluate(() =>
      getComputedStyle(document.querySelector('p.fx-desc[data-show="bloat"]') as HTMLElement).display === "none",
    ));

    /* --- 6) 起動直後のデモ画像上でも選択と Marching Ants が機能する --- */
    await page.click('[data-tool="select-rect"]');
    await new Promise((r) => setTimeout(r, 150));
    await page.mouse.move(cx - 120, cy - 90);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 90, { steps: 10 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 300));
    // 選択矩形の上辺帯 (画面中央より上) を走査し、白破線 (ants) のピクセルを数える
    const antsWhite = await page.evaluate(() => {
      const view = document.querySelector("#view") as HTMLCanvasElement;
      const g = view.getContext("2d")!;
      const w = view.width;
      const h = view.height;
      const band = g.getImageData(Math.round(w / 2) - 150, Math.round(h / 2) - 110, 300, 45).data;
      let count = 0;
      for (let i = 0; i < band.length; i += 4) {
        if (band[i] > 235 && band[i + 1] > 235 && band[i + 2] > 235) count++;
      }
      return count;
    });
    ok("矩形選択で Marching Ants (点線) が表示される", antsWhite > 3, `whitePixels=${antsWhite}`);

    /* --- 7) ツール別パネルの表示整理: 選択中ツールと無関係なボタンは出ない --- */
    const SEL_TOOLS = ["select-rect", "lasso", "polygon", "wand", "mask-pen"];
    for (const tool of ["brush", "bucket", "filter-pen", "select-rect", "puppet-warp"]) {
      await page.click(`[data-tool="${tool}"]`);
      await new Promise((r) => setTimeout(r, 120));
      const labels = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>("#panel-tool button"))
          .filter((b) => b.offsetParent !== null)
          .map((b) => (b.textContent ?? "").trim() || b.id),
      );
      // 「確定/取消」= パペットワープ専用、「塗りつぶし/解除」= 選択系ツール専用
      const stray = labels.filter((label) => {
        if (label === "確定" || label === "取消") return tool !== "puppet-warp";
        if (label === "塗りつぶし" || label === "解除") return !SEL_TOOLS.includes(tool);
        return false;
      });
      ok(`${tool} 選択時に無関係なボタン (確定/取消/塗りつぶし/解除) が表示されない`, stray.length === 0, `stray=${stray.join(",")}`);
    }

    /* --- 8) シャープフィルター (ペン焼き込み / フィルタータブのプレビューとベイク) --- */
    // 新しいページで検証する (前セクションの状態に依存しない)
    {
      const p2 = await browser.newPage();
      p2.on("console", (msg) => console.log(`  [browser] ${msg.text()}`));
      await p2.setViewport({ width: 1280, height: 800 });
      await p2.goto(`${fileUrl}?mode=standalone`);
      await p2.waitForSelector("#layer-list li");
      await new Promise((r) => setTimeout(r, 300));

      // 検証用の人工的なエッジ (水平線) をブラシで描く (既定色 #2563eb はデモ画像と高コントラスト)
      const b2 = (await (await p2.$("#view")).boundingBox())!;
      const cx2 = b2.x + b2.width / 2;
      const cy2 = b2.y + b2.height / 2;
      await p2.click('[data-tool="brush"]');
      await new Promise((r) => setTimeout(r, 120));
      await p2.mouse.move(cx2 - 120, cy2);
      await p2.mouse.down();
      await p2.mouse.move(cx2 + 120, cy2, { steps: 12 });
      await p2.mouse.up();
      await new Promise((r) => setTimeout(r, 150));

      // 変化を読む点: 線の縁 (ブラシ 24px のエッジ帯 = 中心から ±9〜11px) を左半分 / 右半分で
      const EDGE_L: [number, number][] = [[-80, 9], [-80, 11], [-80, -9], [-80, -11]];
      const EDGE_R: [number, number][] = [[80, 9], [80, 11], [80, -9], [80, -11]];
      const readPixels = async (pts: [number, number][]): Promise<[number, number, number][]> => {
        const out: [number, number, number][] = [];
        for (const [dx, dy] of pts) out.push(await viewPixel(p2, dx, dy));
        return out;
      };
      const maxColorDiff = (a: [number, number, number][], b: [number, number, number][]): number =>
        Math.max(...a.map((v, i) => colorDiff(v, b[i])));

      const hasFxUI = (scope: string): Promise<boolean> =>
        p2.evaluate((scope) => {
          const fx = document.querySelector(`[data-fx-scope="${scope}"] .fx[data-fx="sharpen"]`);
          return !!(fx && fx.querySelector('input[data-fx-on="sharpen"]') && fx.querySelector('input[data-fx-range="sharpen"]'));
        }, scope);
      ok("ツールタブ (フィルター効果) にシャープの UI がある", await hasFxUI("pen"));
      ok("フィルタータブにシャープの UI がある", await hasFxUI("image"));

      // フィルターペン: 左半分の線だけなぞってシャープを焼き込む (右半分は焼かない)
      await p2.click('[data-tool="filter-pen"]');
      await new Promise((r) => setTimeout(r, 150));
      const penBaseL = await readPixels(EDGE_L);
      const penBaseR = await readPixels(EDGE_R);
      await setFx(p2, "pen", "sharpen", true, 100);
      await p2.mouse.move(cx2 - 100, cy2);
      await p2.mouse.down();
      await p2.mouse.move(cx2, cy2, { steps: 10 });
      await p2.mouse.up();
      await new Promise((r) => setTimeout(r, 150));
      const diffL = maxColorDiff(penBaseL, await readPixels(EDGE_L));
      const diffR = maxColorDiff(penBaseR, await readPixels(EDGE_R));
      ok("フィルターペン: シャープがなぞった範囲のエッジを強調する", diffL > 8, `diff=${diffL}`);
      ok("フィルターペン: シャープはなぞっていない範囲に及ばない (範囲限定)", diffR < 6, `diff=${diffR}`);

      // フィルタータブ (全体): シャープ ON でプレビュー、OFF で戻る (非破壊)、ベイクで焼き込み
      const fullBase = await readPixels(EDGE_R); // 右半分のエッジ (ペンの影響外)
      await setFx(p2, "image", "sharpen", true, 100);
      await new Promise((r) => setTimeout(r, 100));
      const diffPreview = maxColorDiff(fullBase, await readPixels(EDGE_R));
      ok("フィルタータブ: シャープのプレビューが画像全体 (未ペン範囲) のエッジを強調する", diffPreview > 8, `diff=${diffPreview}`);

      // 強度を下げると効果も弱まる (スライダー全域が有効)
      await setFx(p2, "image", "sharpen", true, 20);
      await new Promise((r) => setTimeout(r, 100));
      const diffWeak = maxColorDiff(fullBase, await readPixels(EDGE_R));
      console.log(`  info  シャーププレビューのエッジ変化量: 強度100%=${diffPreview} / 20%=${diffWeak}`);
      ok("フィルタータブ: 強度を下げるとシャープの効果も弱まる", diffWeak < diffPreview - 5, `weak=${diffWeak} strong=${diffPreview}`);

      await setFx(p2, "image", "sharpen", false);
      await new Promise((r) => setTimeout(r, 100));
      const diffOff = maxColorDiff(fullBase, await readPixels(EDGE_R));
      ok("フィルタータブ: シャープを OFF にするとプレビューは元に戻る (非破壊)", diffOff < 6, `diff=${diffOff}`);

      await setFx(p2, "image", "sharpen", true, 100);
      // 確定(ベイク)ボタンはフィルタータブ内にあるため、タブを切り替えてから押す
      await p2.click('button.tab[data-tab="filter"]');
      await new Promise((r) => setTimeout(r, 150));
      await p2.click("#btn-filter-apply");
      await new Promise((r) => setTimeout(r, 200));
      const diffBaked = maxColorDiff(fullBase, await readPixels(EDGE_R));
      ok("フィルタータブ: 確定(ベイク)でシャープがレイヤーに焼き込まれる", diffBaked > 8, `diff=${diffBaked}`);
      ok("フィルタータブ: ベイク後にシャープの設定はリセットされる", !(await isFxOn(p2, "image", "sharpen")));

      await p2.close();
    }
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();

