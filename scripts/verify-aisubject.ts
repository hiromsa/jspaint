/**
 * scripts/verify-aisubject.ts — AI被写体選択 (U-2-Net) の検証
 *
 * Part 1: subjectMask 純関数の Node 単体テスト (正規化 / しきい値 / 連結成分)
 * Part 2: ブラウザ E2E — スタブ ONNX (scripts/make-stub-model.mjs 生成) で
 *         file:// + IndexedDB キャッシュ込みのパイプライン全体を検証する
 *
 *   テスト画像: SVG で「暗い背景 (#111) + 明るい矩形A (#eee) + やや明るい矩形B (#ddd)」を描く。
 *   スタブモデルはチャンネル平均 (≒輝度) を saliency として返すため、
 *   正規化後の値は A = 1.0 / B = 0.923 / 背景 = 0 となり、しきい値 50% では A+B、
 *   95% では A のみが二値化される (決定論的に検証できる)。
 *
 * 実行: npm run test:aisubject  (事前に npm run build 必須)
 * ブラウザ: インストール済みの Chrome / Edge を自動検出して使用
 */
import puppeteer, { type Page } from "puppeteer-core";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildStubOnnx } from "./make-stub-model.mjs";
import { labelAt, labelComponents, maskOfLabel, normalizeMinMax, thresholdMap } from "../src/ai/subjectMask";

const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

const distFile = path.resolve(process.cwd(), "dist", "index.html");
const stubFile = path.resolve(process.cwd(), "scripts", "fixtures", "u2net-stub.onnx");
/** テスト画像の1辺 (既定ドキュメントと同じ 640) */
const DOC = 640;

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ============ Part 1: subjectMask 純関数 (Node) ============ */

function runPureTests(): void {
  console.log("\n[Part 1] subjectMask 純関数 (Node)");

  const norm = normalizeMinMax(Float32Array.from([0.2, 0.4, 0.6, 0.8]));
  ok("normalizeMinMax: min→0 / max→1", norm[0] === 0 && norm[3] === 1, JSON.stringify([...norm]));
  ok("normalizeMinMax: 中間値が線形", Math.abs(norm[1] - 1 / 3) < 1e-6 && Math.abs(norm[2] - 2 / 3) < 1e-6);

  const flat = normalizeMinMax(Float32Array.from([0.5, 0.5, 0.5]));
  ok("normalizeMinMax: 単色はすべて0 (被写体なし扱い)", [...flat].every((v) => v === 0));

  const bin = thresholdMap(Float32Array.from([0.49, 0.5, 0.51]), 0.5);
  ok("thresholdMap: しきい値以上が1 (以上で境界含む)", bin[0] === 0 && bin[1] === 1 && bin[2] === 1);

  /* 2 つの矩形 + 対角のみの独立点 (4近傍では連結しない) */
  const w = 8;
  const mask = new Uint8Array(w * w);
  mask[1 * w + 1] = 1;
  mask[1 * w + 2] = 1; // 成分A: (1,1)(2,1)
  mask[2 * w + 2] = 1; // 成分A: (2,2) — (2,1) の縦隣 (4近傍で連結)
  mask[4 * w + 4] = 1; // 成分B: (4,4) — (2,2) との対角は連結しない
  mask[6 * w + 6] = 1;
  mask[7 * w + 6] = 1; // 成分C: (6,6)(7,6)
  const { labels, sizes, count } = labelComponents(mask, w, w);
  ok("labelComponents: 成分数は 3 (対角は連結しない)", count === 3, `count=${count} sizes=${JSON.stringify([...sizes])}`);
  ok("labelComponents: 成分サイズ", sizes[1] === 3 && sizes[2] === 1 && sizes[3] === 2, JSON.stringify([...sizes]));
  ok("labelAt: 成分内の点", labelAt(labels, w, 1, 1) > 0 && labelAt(labels, w, 4, 4) > 0 && labelAt(labels, w, 6, 6) > 0);
  ok("labelAt: 異なる成分は別ラベル", labelAt(labels, w, 2, 1) !== labelAt(labels, w, 7, 6));
  ok("labelAt: 背景は 0", labelAt(labels, w, 0, 0) === 0);
  ok("labelAt: 範囲外は 0", labelAt(labels, w, -5, -5) === 0);

  const only = maskOfLabel(mask, labels, labelAt(labels, w, 6, 6));
  ok("maskOfLabel: 指定成分のみ残る", only[6 * w + 6] === 1 && only[7 * w + 6] === 1 && only[1 * w + 1] === 0 && only[4 * w + 4] === 0);
}


/* ============ Part 2: ブラウザ E2E ============ */

async function modelStatusText(page: Page): Promise<string> {
  return page.evaluate(() => (document.querySelector("#ai-model-status") as HTMLElement).textContent ?? "");
}

async function toastText(page: Page): Promise<string> {
  return page.evaluate(() => (document.querySelector("#toasts") as HTMLElement)?.textContent ?? "");
}

/** 既存トーストに既読マーカーを打つ (クリック後に追加されたトーストだけを判定するため) */
async function markToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll("#toasts .toast").forEach((el) => el.setAttribute("data-seen", "1"));
  });
}

/** markToasts 以降に追加されたトーストの末尾が text を含むまで待つ */
async function waitForNewToast(page: Page, text: string, timeoutMs = 8000): Promise<boolean> {
  try {
    await page.waitForFunction(
      (t) => {
        const toasts = [...document.querySelectorAll("#toasts .toast:not([data-seen])")];
        return toasts.length > 0 && toasts[toasts.length - 1].textContent?.includes(t);
      },
      { timeout: timeoutMs },
      text,
    );
    return true;
  } catch {
    return false;
  }
}

/** クリック → 新規トースト待ち (デバッグ用に最終トースト文面も返す) */
async function clickAndToast(page: Page, dx: number, dy: number, text: string, mod?: "shift" | "alt"): Promise<{ hit: boolean; toast: string }> {
  await markToasts(page);
  await clickDoc(page, dx, dy, mod);
  const hit = await waitForNewToast(page, text);
  return { hit, toast: await toastText(page) };
}

async function waitForStatus(page: Page, text: string, timeoutMs = 20000): Promise<boolean> {
  try {
    await page.waitForFunction((t) => ((document.querySelector("#ai-model-status") as HTMLElement)?.textContent ?? "").includes(t), { timeout: timeoutMs }, text);
    return true;
  } catch {
    return false;
  }
}

/** doc 座標 → 画面座標へ変換してクリックする (fitView の式を再現 / doc は 640x640) */
async function clickDoc(page: Page, dx: number, dy: number, mod?: "shift" | "alt"): Promise<void> {
  const p = await page.evaluate(
    ([x, y]) => {
      const view = document.querySelector("#view") as HTMLCanvasElement;
      const ws = document.querySelector("#workspace") as HTMLElement;
      const zoom = Math.min((ws.clientWidth - 56) / 640, (ws.clientHeight - 56) / 640);
      const r = view.getBoundingClientRect();
      return { x: r.left + ws.clientWidth / 2 + (x - 320) * zoom, y: r.top + ws.clientHeight / 2 + (y - 320) * zoom };
    },
    [dx, dy] as [number, number],
  );
  if (mod === "shift") await page.keyboard.down("Shift");
  if (mod === "alt") await page.keyboard.down("Alt");
  await page.mouse.click(p.x, p.y);
  if (mod === "shift") await page.keyboard.up("Shift");
  if (mod === "alt") await page.keyboard.up("Alt");
}

/** doc 矩形内の青 (#2563eb) 画素数を数える (内側にマージンを置いて Marching Ants を避ける) */
async function blueInDocRect(page: Page, dx0: number, dy0: number, dx1: number, dy1: number): Promise<{ blue: number; total: number }> {
  return page.evaluate(
    ([x0, y0, x1, y1]) => {
      const view = document.querySelector("#view") as HTMLCanvasElement;
      const ws = document.querySelector("#workspace") as HTMLElement;
      const zoom = Math.min((ws.clientWidth - 56) / 640, (ws.clientHeight - 56) / 640);
      const m = 2;
      const px0 = Math.max(0, Math.round(view.width / 2 + (x0 + m - 320) * zoom));
      const py0 = Math.max(0, Math.round(view.height / 2 + (y0 + m - 320) * zoom));
      const px1 = Math.min(view.width, Math.round(view.width / 2 + (x1 - m - 320) * zoom));
      const py1 = Math.min(view.height, Math.round(view.height / 2 + (y1 - m - 320) * zoom));
      const d = view.getContext("2d")!.getImageData(px0, py0, px1 - px0, py1 - py0).data;
      let blue = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - 0x25) < 50 && Math.abs(d[i + 1] - 0x63) < 50 && d[i + 2] > 0xc0) blue++;
      }
      return { blue, total: (px1 - px0) * (py1 - py0) };
    },
    [dx0, dy0, dx1, dy1] as [number, number, number, number],
  );
}

async function fillSelection(page: Page): Promise<void> {
  await page.keyboard.down("Alt");
  await page.keyboard.press("Delete");
  await page.keyboard.up("Alt");
  await sleep(250);
}

async function undoOnce(page: Page): Promise<void> {
  await page.keyboard.down("Control");
  await page.keyboard.press("z");
  await page.keyboard.up("Control");
  await sleep(200);
}

async function setThreshold(page: Page, value: number): Promise<void> {
  await page.evaluate((v) => {
    const el = document.querySelector("#ctl-ai-threshold") as HTMLInputElement;
    el.value = String(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  await sleep(100);
}

/** テスト画像 (暗い背景 + 矩形A #eee + 矩形B #ddd) の SVG を書き出す */
function writeTestImage(dir: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${DOC}" height="${DOC}"><rect width="${DOC}" height="${DOC}" fill="#111111"/><rect x="80" y="80" width="200" height="200" fill="#eeeeee"/><rect x="360" y="360" width="200" height="200" fill="#dddddd"/></svg>`;
  const file = path.join(dir, "ai-test.svg");
  writeFileSync(file, svg, "utf8");
  return file;
}


async function runE2E(): Promise<void> {
  console.log("\n[Part 2] ブラウザ E2E (file:// + IndexedDB + スタブONNX)");

  /* ビルドの単一性: wasm が別ファイルに分離していないこと (file:// では fetch できない) */
  const distFiles = readdirSync(path.dirname(distFile));
  ok("dist は index.html のみ (wasm が分離していない)", distFiles.length === 1 && distFiles[0] === "index.html", JSON.stringify(distFiles));

  const executablePath = BROWSER_CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) {
    console.error("Chrome / Edge が見つかりませんでした。");
    process.exit(1);
  }

  const tmp = mkdirSync(path.join(tmpdir(), `jspaint-ai-${Date.now()}`), { recursive: true });
  const svgFile = writeTestImage(tmp);
  const browser = await puppeteer.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });

  /* ブラウザログの記録 (失敗時の詳細を出すため) */
  const consoleLog: string[] = [];
  page.on("console", (m) => consoleLog.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLog.push(`[pageerror] ${e.message}`));

  try {
    await page.goto(pathToFileURL(distFile).href, { waitUntil: "load" });
    await page.waitForSelector("#layer-list li");
    await sleep(300);

    /* --- 1) AIツールの選択と初期状態 --- */
    await page.click('[data-tool="ai-select"]');
    await sleep(200);
    const title = await page.evaluate(() => (document.querySelector("#tool-title") as HTMLElement).textContent ?? "");
    ok("ツールボタンで「AI被写体選択」を選択できる", title === "AI被写体選択", title);
    const panelVisible = await page.evaluate(() => {
      const el = document.querySelector('#panel-tool [data-show="ai-select"]');
      return el ? !el.classList.contains("is-hidden") : false;
    });
    ok("ツールタブにAI選択の設定ブロックが表示される", panelVisible);
    ok("初期状態のモデルステータスは「未読み込み」", (await modelStatusText(page)) === "未読み込み", await modelStatusText(page));

    /* --- 2) テスト画像を読み込む --- */
    const fileInput = await page.$("#file-open");
    await fileInput!.uploadFile(svgFile);
    await sleep(400);
    const dim = await page.evaluate(() => (document.querySelector("#doc-dim") as HTMLElement).textContent ?? "");
    ok("テスト画像 (640×640) でドキュメントを差し替え", dim.includes("640"), dim);

    /* --- 3) スタブモデル (.onnx) を読み込む → ort起動 + IndexedDB キャッシュ --- */
    const modelInput = await page.$("#file-ai-model");
    await modelInput!.uploadFile(stubFile);
    const loaded = await waitForStatus(page, "利用可能");
    ok("モデル読み込み後、ステータスが「利用可能」になる", loaded, `${await modelStatusText(page)} | logs: ${consoleLog.slice(-6).join(" / ")}`);

    /* --- 4) 矩形A をクリック → 選択 → 塗りつぶしで検証 --- */
    const r4 = await clickAndToast(page, 180, 180, "AI被写体選択");
    ok("AI選択の完了トーストが出る", r4.hit, r4.toast);
    await fillSelection(page);
    const a1 = await blueInDocRect(page, 80, 80, 280, 280);
    const b1 = await blueInDocRect(page, 360, 360, 560, 560);
    const bg1 = await blueInDocRect(page, 20, 20, 70, 70);
    ok("矩形A が選択され塗りつぶされている", a1.blue > a1.total * 0.9, JSON.stringify(a1));
    ok("矩形B は非選択", b1.blue < 10, JSON.stringify(b1));
    ok("背景も非選択", bg1.blue < 10, JSON.stringify(bg1));

    /* --- 5) Shift+クリック (追加) --- */
    await undoOnce(page);
    const r5 = await clickAndToast(page, 460, 460, "AI被写体選択", "shift");
    ok("追加選択のトーストが出る", r5.hit, r5.toast);
    await fillSelection(page);
    const a2 = await blueInDocRect(page, 80, 80, 280, 280);
    const b2 = await blueInDocRect(page, 360, 360, 560, 560);
    ok("Shift+クリックで矩形B が追加される", a2.blue > a2.total * 0.9 && b2.blue > b2.total * 0.9, `A=${JSON.stringify(a2)} B=${JSON.stringify(b2)}`);

    /* --- 6) Alt+クリック (除外) --- */
    await undoOnce(page);
    const r6 = await clickAndToast(page, 460, 460, "AI被写体選択", "alt");
    ok("除外選択のトーストが出る", r6.hit, r6.toast);
    await fillSelection(page);
    const a3 = await blueInDocRect(page, 80, 80, 280, 280);
    const b3 = await blueInDocRect(page, 360, 360, 560, 560);
    ok("Alt+クリックで矩形B が除外される", a3.blue > a3.total * 0.9 && b3.blue < 10, `A=${JSON.stringify(a3)} B=${JSON.stringify(b3)}`);

    /* --- 7) しきい値 95% では矩形B (正規化値 0.923) は検出されない --- */
    await undoOnce(page);
    await setThreshold(page, 95);
    const r7 = await clickAndToast(page, 460, 460, "見つかりません");
    ok("しきい値超過なしのトーストが出る", r7.hit, r7.toast);

    /* --- 8) しきい値 50% に戻して新規選択 (前の選択は置き換わる) --- */
    await setThreshold(page, 50);
    const r8 = await clickAndToast(page, 460, 460, "AI被写体選択");
    ok("しきい値を戻すと矩形B が選択できる", r8.hit, r8.toast);
    await fillSelection(page);
    const a4 = await blueInDocRect(page, 80, 80, 280, 280);
    const b4 = await blueInDocRect(page, 360, 360, 560, 560);
    ok("新規選択モードで選択は矩形B だけに置き換わる", b4.blue > b4.total * 0.9 && a4.blue < 10, `A=${JSON.stringify(a4)} B=${JSON.stringify(b4)}`);

    /* --- 9) IndexedDB キャッシュの永続化 (リロード後に自動ウォームアップ) --- */
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#layer-list li");
    await page.click('[data-tool="ai-select"]');
    ok("リロード後もキャッシュから「利用可能」になる (IndexedDB 永続化)", await waitForStatus(page, "利用可能", 25000), await modelStatusText(page));

    /* --- 10) モデル削除 --- */
    await page.evaluate(() => (document.querySelector("#btn-ai-model-remove") as HTMLButtonElement).click());
    ok("削除後、ステータスが「未読み込み」に戻る", await waitForStatus(page, "未読み込み"), await modelStatusText(page));
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#layer-list li");
    await page.click('[data-tool="ai-select"]');
    await sleep(2500);
    ok("削除後のリロードでは「未読み込み」のまま", (await modelStatusText(page)) === "未読み込み", await modelStatusText(page));
  } finally {
    await browser.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ============ エントリポイント ============ */

async function main(): Promise<void> {
  if (!existsSync(distFile)) {
    console.error("dist/index.html がありません。先に `npm run build` を実行してください。");
    process.exit(1);
  }
  // スタブモデルがなければ生成する (リポジトリにはコミット済みだが消失時の自己修復)
  if (!existsSync(stubFile)) {
    mkdirSync(path.dirname(stubFile), { recursive: true });
    writeFileSync(stubFile, buildStubOnnx());
    console.log(`stub model generated: ${stubFile}`);
  }

  runPureTests();
  await runE2E();

  console.log(`\n結果: ${passed} 合格 / ${failed} 失敗`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

