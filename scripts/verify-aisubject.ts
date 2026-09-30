/**
 * scripts/verify-aisubject.ts — AI被写体選択 (SlimSAM 対話セグメンテーション) の E2E 検証
 *
 * スタブ ONNX (scripts/make_stub_sam.py が生成 — 「チャンネル平均を logits として返す」最小モデル)
 * を使い、本物のモデル (約40MB ×2) なしでパイプライン全体を検証する:
 *
 *   - dist が単一ファイルのこと (wasm 分離なし = file:// で動作する条件)
 *   - ツール選択 / パネル表示 / ステータス遷移 / セットアップモーダル (ダウンロード元リンク)
 *   - SVG テスト画像 (暗い背景 + 矩形A #eee + 矩形B #ddd) でのポイント選択:
 *     スタブ logits は「明るい領域ほど正」のため、クリック1回で A∪B が選択される (決定論的)
 *   - Enter / Esc (ポイントの確定・クリア) / **IndexedDB 永続化** (リロード後の自動ウォームアップ) / モデル削除
 *
 * 実行: npm run test:aisubject  (事前に npm run build 必須)
 * ブラウザ: インストール済みの Chrome / Edge を自動検出して使用
 */
import puppeteer, { type Page } from "puppeteer-core";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

const distFile = path.resolve(process.cwd(), "dist", "index.html");
const stubFiles = [
  path.resolve(process.cwd(), "scripts", "fixtures", "vision_encoder-stub.onnx"),
  path.resolve(process.cwd(), "scripts", "fixtures", "prompt_encoder_mask_decoder-stub.onnx"),
];
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

/* ============ ヘルパー ============ */

async function modelStatusText(page: Page): Promise<string> {
  return page.evaluate(() => (document.querySelector("#ai-model-status") as HTMLElement).textContent ?? "");
}

async function waitForStatus(page: Page, text: string, timeoutMs = 20000): Promise<boolean> {
  try {
    await page.waitForFunction((t) => ((document.querySelector("#ai-model-status") as HTMLElement)?.textContent ?? "").includes(t), { timeout: timeoutMs }, text);
    return true;
  } catch {
    return false;
  }
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

/** テスト画像 (暗い背景 + 矩形A #eee + 矩形B #ddd) の SVG を書き出す */
function writeTestImage(dir: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${DOC}" height="${DOC}"><rect width="${DOC}" height="${DOC}" fill="#111111"/><rect x="80" y="80" width="200" height="200" fill="#eeeeee"/><rect x="360" y="360" width="200" height="200" fill="#dddddd"/></svg>`;
  const file = path.join(dir, "ai-test.svg");
  writeFileSync(file, svg, "utf8");
  return file;
}


/* ============ E2E 本体 ============ */

async function runE2E(): Promise<void> {
  console.log("\n[E2E] file:// + IndexedDB + スタブ SlimSAM");

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
  const consoleLog: string[] = [];
  page.on("console", (m) => consoleLog.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLog.push(`[pageerror] ${e.message}`));

  try {
    await page.goto(pathToFileURL(distFile).href, { waitUntil: "load" });
    await page.waitForSelector("#layer-list li");
    await sleep(300);

    /* --- 1) AIツールの選択と初期状態 --- */
    await page.click('[data-tool="ai-select"]');
    await sleep(250);
    const title = await page.evaluate(() => (document.querySelector("#tool-title") as HTMLElement).textContent ?? "");
    ok("ツールボタンで「AI被写体選択」を選択できる", title === "AI被写体選択", title);
    const panelVisible = await page.evaluate(() => {
      const el = document.querySelector('#panel-tool [data-show="ai-select"]');
      return el ? !el.classList.contains("is-hidden") : false;
    });
    ok("ツールタブにAI選択の設定ブロックが表示される", panelVisible);
    ok("初期状態のモデルステータスは「未読み込み」", (await modelStatusText(page)) === "未読み込み (2ファイル)", await modelStatusText(page));

    /* --- 1b) モデル未読み込みでクリック → セットアップモーダル (ダウンロード元の案内) --- */
    await clickDoc(page, 180, 180);
    ok("モデル未読み込みのクリックでセットアップモーダルが開く", await page.evaluate(() => !(document.querySelector("#modal-ai-model") as HTMLElement).hidden));
    const sources = await page.evaluate(() => [...document.querySelectorAll("#ai-source-list a.ai-source")].map((a) => (a as HTMLAnchorElement).href));
    ok(
      "ダウンロード元リンクが2件表示される (エンコーダ / デコーダ)",
      sources.length === 2 && sources[0].includes("vision_encoder.onnx") && sources[1].includes("prompt_encoder_mask_decoder.onnx"),
      JSON.stringify(sources),
    );
    await page.keyboard.press("Escape");
    ok("Esc でセットアップモーダルを閉じられる", await page.evaluate(() => (document.querySelector("#modal-ai-model") as HTMLElement).hidden));
    await page.evaluate(() => (document.querySelector("#btn-ai-model-help") as HTMLButtonElement).click());
    ok("パネルの「ダウンロード元…」でモーダルを再表示できる", await page.evaluate(() => !(document.querySelector("#modal-ai-model") as HTMLElement).hidden));
    await page.evaluate(() => (document.querySelector("#modal-ai-model .modal__foot [data-ai-close]") as HTMLElement).click());
    ok("閉じるボタンでモーダルを閉じられる", await page.evaluate(() => (document.querySelector("#modal-ai-model") as HTMLElement).hidden));

    /* --- 2) テスト画像を読み込む --- */
    const fileInput = await page.$("#file-open");
    await fileInput!.uploadFile(svgFile);
    await sleep(400);
    const dim = await page.evaluate(() => (document.querySelector("#doc-dim") as HTMLElement).textContent ?? "");
    ok("テスト画像 (640×640) でドキュメントを差し替え", dim.includes("640"), dim);

    /* --- 3) スタブモデル ×2 を読み込む → ort起動 + IndexedDB キャッシュ --- */
    const modelInput = await page.$("#file-ai-model");
    await modelInput!.uploadFile(...stubFiles);
    const loaded = await waitForStatus(page, "利用可能");
    ok("両モデルの読み込み後、ステータスが「利用可能」になる", loaded, `${await modelStatusText(page)} | ${consoleLog.slice(-4).join(" / ")}`);

    /* --- 4) クリックでポイント指定 → マスク (スタブは明るい領域 A∪B) が選択される --- */
    await markToasts(page);
    await clickDoc(page, 180, 180);
    const r4 = await waitForNewToast(page, "AI選択を更新");
    ok("ポイント指定のトースト (IoU付き) が出る", r4, `${(await toastText(page)).slice(-120)} | ${consoleLog.slice(-10).join(" / ")}`);
    await fillSelection(page);
    const a1 = await blueInDocRect(page, 80, 80, 280, 280);
    const b1 = await blueInDocRect(page, 360, 360, 560, 560);
    const bg1 = await blueInDocRect(page, 20, 20, 70, 70);
    ok("矩形A が選択され塗りつぶされている", a1.blue > a1.total * 0.9, JSON.stringify(a1));
    ok("矩形B も同時に選択されている (スタブは明るい領域全体を返す)", b1.blue > b1.total * 0.9, JSON.stringify(b1));
    ok("背景は非選択", bg1.blue < 10, JSON.stringify(bg1));

    /* --- 5) Esc でポイントをクリア (選択範囲は維持) --- */
    await undoOnce(page);
    await page.keyboard.press("Escape");
    ok("Esc でポイントクリアのトーストが出る", await waitForNewToast(page, "ポイントをクリア"));
    await fillSelection(page);
    const a2 = await blueInDocRect(page, 80, 80, 280, 280);
    ok("ポイントクリア後も選択範囲は維持される", a2.blue > a2.total * 0.9, JSON.stringify(a2));

    /* --- 6) Enter でポイント指定を確定 --- */
    await undoOnce(page);
    await clickDoc(page, 460, 460);
    ok("追加ポイントのトーストが出る", await waitForNewToast(page, "AI選択を更新"));
    await page.keyboard.press("Enter");
    ok("Enter でポイント確定のトーストが出る", await waitForNewToast(page, "ポイントをクリア"));

    /* --- 7) IndexedDB キャッシュの永続化 (リロード後に自動ウォームアップ) --- */
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#layer-list li");
    await page.click('[data-tool="ai-select"]');
    ok("リロード後もキャッシュから「利用可能」になる (IndexedDB 永続化)", await waitForStatus(page, "利用可能", 25000), await modelStatusText(page));

    /* --- 8) モデル削除 --- */
    await page.evaluate(() => (document.querySelector("#btn-ai-model-remove") as HTMLButtonElement).click());
    ok("削除後、ステータスが「未読み込み」に戻る", await waitForStatus(page, "未読み込み"), await modelStatusText(page));
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector("#layer-list li");
    await page.click('[data-tool="ai-select"]');
    await sleep(2500);
    ok("削除後のリロードでは「未読み込み」のまま", (await modelStatusText(page)).includes("未読み込み"), await modelStatusText(page));
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
  // スタブモデルがなければ python で生成する (リポジトリにはコミット済みだが消失時の自己修復)
  if (stubFiles.some((f) => !existsSync(f))) {
    mkdirSync(path.dirname(stubFiles[0]), { recursive: true });
    try {
      require("node:child_process").execSync("python scripts/make_stub_sam.py", { stdio: "inherit", cwd: process.cwd() });
    } catch {
      console.error("スタブモデルの生成に失敗しました (python + onnx が必要です)");
      process.exit(1);
    }
  }

  await runE2E();

  console.log(`\n結果: ${passed} 合格 / ${failed} 失敗`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

