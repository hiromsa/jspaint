/**
 * scripts/verify-maskdisplay.ts — Inpainting マスクレイヤーの「ドット網掛」表示の E2E 検証
 *
 * SD WebUI Forge の Inpaint マスク (high contrast) と同様に、マスク指定レイヤーが
 * 白黒チェッカーパターン (10px) × 50% 不透明度で表示されることを、
 * view キャンバスの画素を走査して検証する。
 *
 *   1) JSPAINT_LOAD でマスク付き画像を受信 → マスク領域のみドット網掛で表示される
 *   2) マスク指定を解除 → 通常表示 (レイヤーの実ピクセル) に戻る
 *   3) マスク指定を付け直す → ドット網掛が復帰する
 *   4) マスクレイヤーにブラシ描画 → 描画色がそのまま出らずドット表示のまま
 *
 * 実行: npm run test:maskdisplay  (事前に npm run build が必要)
 * ブラウザ: インストール済みの Chrome / Edge を自動検出して使用 (追加ダウンロード不要)
 */
import puppeteer from "puppeteer-core";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Frame, Page } from "puppeteer-core";

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

/** view キャンバスの中央 1 行を走査した統計 (doc 部分の画素のみ) */
interface RowStats {
  /** 明るい画素 (lum >= 200) — ホワイトタイル / 元画像 */
  bright: number;
  /** 中間の画素 (90 <= lum < 200) — ブラックタイル (白地の上) */
  mid: number;
  /** 暗い画素 (lum < 90) — ブラックタイル (着色ペイントの上) */
  dark: number;
  /** 中間画素のうち doc 左半分 (マスク領域側) の数 */
  midLeft: number;
  /** 中間画素のうち doc 右半分 (元画像側) の数 */
  midRight: number;
  /** doc 表示範囲の幅 (screen px) */
  span: number;
  /** 描画色 (#2563eb) がそのまま表示されている画素数 (網掛表示なら 0 のはず) */
  rawPaintPixels: number;
}

/** frame 内の #view 中央行を走査して統計を取る */
async function scanCenterRow(frame: Frame): Promise<RowStats> {
  return frame.evaluate(() => {
    const view = document.querySelector("#view") as HTMLCanvasElement;
    const g = view.getContext("2d")!;
    const y = Math.floor(view.height / 2);
    const d = g.getImageData(0, y, view.width, 1).data;
    let bright = 0, mid = 0, dark = 0, midLeft = 0, midRight = 0, rawPaintPixels = 0;
    let minX = -1, maxX = -1;
    const cx = view.width / 2;
    for (let x = 0; x < view.width; x++) {
      const i = x * 4;
      if (d[i + 3] < 200) continue; // doc 外 (ワークスペース背景は透過)
      if (minX < 0) minX = x;
      maxX = x;
      const r = d[i], gr = d[i + 1], b = d[i + 2];
      const lum = 0.299 * r + 0.587 * gr + 0.114 * b;
      if (lum >= 200) bright++;
      else if (lum >= 90) {
        mid++;
        if (x < cx) midLeft++; else midRight++;
      } else dark++;
      // 描画色そのもの (既定の #2563eb) が露出していないか (網掛なら 50% 合成されて別色になる)
      if (Math.abs(r - 0x25) < 30 && Math.abs(gr - 0x63) < 30 && Math.abs(b - 0xeb) < 30) rawPaintPixels++;
    }
    return { bright, mid, dark, midLeft, midRight, span: maxX < 0 ? 0 : maxX - minX + 1, rawPaintPixels };
  });
}

/** レイヤー行のサムネイル canvas を走査した統計 */
interface ThumbStats {
  /** 不透明画素数 (alpha >= 200) */
  content: number;
  /** 白タイルの画素数 (lum >= 200) */
  white: number;
  /** 黒タイルの画素数 (lum <= 60) */
  black: number;
  /** 右半分 (doc のマスク透明側) の不透明画素数 */
  rightContent: number;
  /** 描画色 (#2563eb) がそのまま出ている画素数 */
  rawBlue: number;
}

/** 指定レイヤー行 (rowSelector) のサムネイル canvas を走査する */
async function scanThumb(frame: Frame, rowSelector: string): Promise<ThumbStats> {
  return frame.evaluate((sel) => {
    const canvas = document.querySelector(`${sel} .layer__thumb canvas`) as HTMLCanvasElement | null;
    if (!canvas) return { content: -1, white: -1, black: -1, rightContent: -1, rawBlue: -1 };
    const g = canvas.getContext("2d")!;
    const w = canvas.width;
    const h = canvas.height;
    const d = g.getImageData(0, 0, w, h).data;
    let content = 0, white = 0, black = 0, rightContent = 0, rawBlue = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (d[i + 3] < 200) continue;
        content++;
        if (x >= w / 2) rightContent++;
        const r = d[i], gr = d[i + 1], b = d[i + 2];
        const lum = 0.299 * r + 0.587 * gr + 0.114 * b;
        if (lum >= 200) white++;
        else if (lum <= 60) black++;
        if (Math.abs(r - 0x25) < 30 && Math.abs(gr - 0x63) < 30 && Math.abs(b - 0xeb) < 30) rawBlue++;
      }
    }
    return { content, white, black, rightContent, rawBlue };
  }, rowSelector);
}

async function main(): Promise<void> {
  if (!existsSync(distFile)) {
    throw new Error(`dist/index.html がありません: ${distFile} (npm run build を先に実行)`);
  }
  const executablePath = BROWSER_CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) throw new Error("Chrome / Edge が見つかりません");

  const distUrl = pathToFileURL(distFile).href;

  /* Forge 拡張相当の親ページ (JSPAINT_LOAD の送信) */
  const tmp = mkdtempSync(path.join(tmpdir(), "jspaint2-maskdisplay-"));
  const hostFile = path.join(tmp, "host.html");
  writeFileSync(
    hostFile,
    `<!doctype html><html><body>
<script>
  window.sendLoad = (payload) => document.querySelector("#paint").contentWindow.postMessage(payload, "*");
</script>
<iframe id="paint" src="${distUrl}?mode=embed" style="width:1280px;height:820px;border:0"></iframe>
</body></html>`,
  );

  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page: Page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(hostFile).href);

    const handle = await page.$("#paint");
    const frame = await handle!.contentFrame();
    if (!frame) throw new Error("iframe が見つかりません");
    await frame.waitForSelector("#layer-list li");

    /* ========== テスト画像: 白 256×128 + 左半分が白のマスク ========== */
    const { image, mask } = await page.evaluate(() => {
      const img = document.createElement("canvas");
      img.width = 256;
      img.height = 128;
      const ig = img.getContext("2d")!;
      ig.fillStyle = "#ffffff";
      ig.fillRect(0, 0, 256, 128);
      const msk = document.createElement("canvas");
      msk.width = 256;
      msk.height = 128;
      const mg = msk.getContext("2d")!;
      mg.fillStyle = "#000000";
      mg.fillRect(0, 0, 256, 128);
      mg.fillStyle = "#ffffff";
      mg.fillRect(0, 0, 128, 128); // 左半分がマスクあり
      return { image: img.toDataURL("image/png"), mask: msk.toDataURL("image/png") };
    });

    await page.evaluate((payload) => (window as any).sendLoad(payload), { type: "JSPAINT_LOAD", image, mask, name: "masktest.png" });
    await frame.waitForFunction(
      (dim) => (document.querySelector("#doc-dim") as HTMLElement).textContent === dim,
      { timeout: 5000 },
      "256×128",
    );
    await frame.waitForFunction(
      (n) => Number((document.querySelector("#layer-count") as HTMLElement).textContent) === n,
      { timeout: 5000 },
      2,
    );
    await new Promise((r) => setTimeout(r, 200));

    /* ========== 1) マスク領域のみドット網掛で表示される ========== */
    console.log("\n[ドット網掛表示]");
    const s1 = await scanCenterRow(frame);
    ok("doc が fit 表示されている", s1.span > 400, `span=${s1.span}`);
    ok("マスク領域がチェッカー表示される (中間調あり)", s1.mid > 40, `mid=${s1.mid}`);
    ok("網掛は白黒の 2 値 (+50% 合成) で暗画素はほぼ無い", s1.dark < 10, `dark=${s1.dark}`);
    ok("網掛は doc 左半分 (マスク領域) に限定される", s1.midLeft > 40 && s1.midRight < 10, `left=${s1.midLeft} right=${s1.midRight}`);

    /* ========== 2) マスク指定を解除すると通常表示に戻る ========== */
    console.log("\n[マスク指定解除]");
    await frame.evaluate(() => {
      (document.querySelector("#layer-list li:first-child .layer__mask") as HTMLElement).click();
    });
    await new Promise((r) => setTimeout(r, 200));
    const s2 = await scanCenterRow(frame);
    ok("指定解除でドットが消え通常表示になる", s2.mid < 10 && s2.bright > 100, `mid=${s2.mid} bright=${s2.bright}`);

    /* ========== 3) 指定を付け直すと網掛が復帰する ========== */
    console.log("\n[マスク指定の付け直し]");
    await frame.evaluate(() => {
      (document.querySelector("#layer-list li:first-child .layer__mask") as HTMLElement).click();
    });
    await new Promise((r) => setTimeout(r, 200));
    const s3 = await scanCenterRow(frame);
    ok("再指定でドット網掛が復帰する", s3.mid > 40 && s3.midLeft > 40, `mid=${s3.mid}`);

    /* ========== 4) 描画色がそのまま出らずドット表示のまま ========== */
    console.log("\n[マスクレイヤーへの描画]");
    // マスクレイヤー (最上位) をアクティブにする
    await frame.evaluate(() => {
      (document.querySelector("#layer-list li:first-child") as HTMLElement).click();
    });
    await new Promise((r) => setTimeout(r, 150));

    // ページ座標へ変換 (iframe 原点 + view のローカル rect)
    const iframeBox = (await (await page.$("#paint")).boundingBox())!;
    const vrect = await frame.evaluate(() => {
      const r = (document.querySelector("#view") as HTMLCanvasElement).getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    const vcx = iframeBox.x + vrect.x + vrect.w / 2;
    const vcy = iframeBox.y + vrect.y + vrect.h / 2;
    // doc 右半分 (マスクの透明部分) に既定色 #2563eb で一筆 — 透明部分への描画は
    // レイヤーのアルファを生やし、表示は「色に関係なく」ドットとして現れる
    await page.mouse.move(vcx + s1.span / 4, vcy);
    await page.mouse.down();
    await page.mouse.move(vcx + s1.span * 0.45, vcy, { steps: 12 });
    await page.mouse.up();
    // カーソルオーバーレイを消すため view の外へ退避
    await page.mouse.move(iframeBox.x - 40, iframeBox.y - 40);
    await new Promise((r) => setTimeout(r, 200));

    const s4 = await scanCenterRow(frame);
    ok("マスクの透明部分への描画がドット網掛として現れる", s4.midRight > 40, `right=${s4.midRight}`);
    ok("描画後も網掛は白黒のまま (暗画素はほぼ無い)", s4.dark < 10, `dark=${s4.dark}`);
    ok("描画色 (#2563eb) がそのまま表示されない (すべて網掛合成色)", s4.rawPaintPixels === 0, `raw=${s4.rawPaintPixels}`);

    /* ========== 5) レイヤーサムネイルもドット表示に統一される ========== */
    console.log("\n[サムネイルのドット表示]");
    // サムネイルはレイヤー操作時に再生成されるため、行クリック (selectLayer) で最新化してから走査する
    await frame.evaluate(() => {
      (document.querySelector("#layer-list li:first-child") as HTMLElement).click();
    });
    await new Promise((r) => setTimeout(r, 200));

    const maskThumb = await scanThumb(frame, "#layer-list li:first-child");
    ok("マスクレイヤーのサムネイルに白タイルと黒タイルがある (ドット化)", maskThumb.white > 0 && maskThumb.black > 0, JSON.stringify(maskThumb));
    ok("マスクサムネイルに描画色が露出しない", maskThumb.rawBlue === 0, `raw=${maskThumb.rawBlue}`);
    ok("マスクの透明部分に描いたストロークもサムネイルに反映される", maskThumb.rightContent > 0, `right=${maskThumb.rightContent}`);

    const baseThumb = await scanThumb(frame, "#layer-list li:nth-child(2)");
    ok("マスク以外のレイヤーのサムネイルはドット化しない", baseThumb.black === 0 && baseThumb.white > 0, JSON.stringify(baseThumb));

    /* ========== まとめ ========== */
    console.log(`\n結果: ${passed} 合格 / ${failed} 失敗`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await browser.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
