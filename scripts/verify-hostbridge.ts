/**
 * scripts/verify-hostbridge.ts — ホスト連携 (JSPAINT_LOAD / JSPAINT_EXPORT) の E2E 検証
 *
 * Forge 拡張 (stable-diffusion-webui-jspaint2) と同じ構成
 * (親ページ + iframe ?mode=embed + postMessage) を再現し、
 * 画像 + マスクの受け渡しを双方向で検証する。
 *
 * 実行: npm run test:hostbridge  (事前に npm run build が必要)
 * ブラウザ: インストール済みの Chrome / Edge を自動検出して使用 (追加ダウンロード不要)
 */
import puppeteer from "puppeteer-core";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
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

interface ExportMessage {
  compositeImage: string;
  maskImage: string;
}

async function main(): Promise<void> {
  if (!existsSync(distFile)) {
    throw new Error(`dist/index.html がありません: ${distFile} (npm run build を先に実行)`);
  }
  const executablePath = BROWSER_CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) throw new Error("Chrome / Edge が見つかりません");

  const distUrl = pathToFileURL(distFile).href;

  /* Forge 拡張相当の親ページ (JSPAINT_EXPORT の受信 + JSPAINT_LOAD の送信) */
  const tmp = mkdtempSync(path.join(tmpdir(), "jspaint2-hostbridge-"));
  const hostFile = path.join(tmp, "host.html");
  writeFileSync(
    hostFile,
    `<!doctype html><html><body>
<script>
  window.exportMessage = null;
  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "JSPAINT_EXPORT") window.exportMessage = e.data;
  });
  window.sendLoad = (payload) => document.querySelector("#paint").contentWindow.postMessage(payload, "*");
</script>
<iframe id="paint" src="${distUrl}?mode=embed" style="width:1280px;height:820px;border:0"></iframe>
</body></html>`,
  );

  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto(pathToFileURL(hostFile).href);

    const handle = await page.$("#paint");
    const frame = await handle!.contentFrame();
    if (!frame) throw new Error("iframe が見つかりません");
    await frame.waitForSelector("#layer-list li");

    /* ========== 1) JSPAINT_LOAD: 画像 + マスク ========== */
    console.log("\n[JSPAINT_LOAD]");
    const { image, mask } = await page.evaluate(() => {
      const img = document.createElement("canvas");
      img.width = 256;
      img.height = 128;
      const ig = img.getContext("2d")!;
      const grad = ig.createLinearGradient(0, 0, 256, 128);
      grad.addColorStop(0, "#ff0000");
      grad.addColorStop(1, "#0000ff");
      ig.fillStyle = grad;
      ig.fillRect(0, 0, 256, 128);
      // マスク: 黒背景 + 左半分が白 (白 = 再生成したい領域)
      const msk = document.createElement("canvas");
      msk.width = 256;
      msk.height = 128;
      const mg = msk.getContext("2d")!;
      mg.fillStyle = "#000000";
      mg.fillRect(0, 0, 256, 128);
      mg.fillStyle = "#ffffff";
      mg.fillRect(0, 0, 128, 128);
      return { image: img.toDataURL("image/png"), mask: msk.toDataURL("image/png") };
    });

    await page.evaluate((payload) => (window as any).sendLoad(payload), { type: "JSPAINT_LOAD", image, mask, name: "test.png" });

    await frame.waitForFunction(
      (dim) => (document.querySelector("#doc-dim") as HTMLElement).textContent === dim,
      { timeout: 5000 },
      "256×128",
    );
    ok("JSPAINT_LOAD でドキュメントが差し替わる (256×128)", true);
    ok(
      "ドキュメント名が name で更新される",
      (await frame.evaluate(() => (document.querySelector("#doc-name") as HTMLElement).textContent)) === "test.png",
    );
    await frame.waitForFunction(
      (n) => Number((document.querySelector("#layer-count") as HTMLElement).textContent) === n,
      { timeout: 5000 },
      2,
    );
    ok(
      "元画像 + Inpaintマスク の 2 レイヤーになる",
      (await frame.evaluate(() => Number((document.querySelector("#layer-count") as HTMLElement).textContent))) === 2,
    );
    ok(
      "受け取ったマスクレイヤーが Inpainting マスク指定になっている (レイヤー行に is-mask)",
      await frame.evaluate(() => {
        const items = document.querySelectorAll("#layer-list li");
        const first = items[0]; // レイヤーリストは上のレイヤーが先頭
        return !!first && first.classList.contains("is-mask") && !!first.querySelector(".layer__mask");
      }),
    );
    ok(
      "開いた直後のカレントレイヤーはマスクではない (元画像がアクティブ)",
      await frame.evaluate(() => {
        const items = document.querySelectorAll("#layer-list li");
        const maskRow = items[0]; // Inpaintマスク (最上位)
        const baseRow = items[1]; // 元画像
        return !!maskRow && !!baseRow && !maskRow.classList.contains("is-active") && baseRow.classList.contains("is-active");
      }),
    );

    // 手動トグル: マスク指定ボタンで解除 → 指定なしに戻る
    // (パネルがビューポート外になることがあるため click は DOM 発火で行う)
    const toggleMask = () =>
      frame.evaluate(() => {
        const btn = document.querySelector("#layer-list li:first-child .layer__mask") as HTMLElement | null;
        if (!btn) throw new Error("layer__mask button not found");
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    await toggleMask();
    await frame.waitForFunction(
      () => !document.querySelector("#layer-list li.is-mask"),
      { timeout: 3000 },
    );
    ok("マスク指定ボタンで解除できる (トグル)", true);
    // 再指定して元に戻す (以降のエクスポート検証は「指定レイヤーからマスク生成」の経路を使う)
    await toggleMask();
    await frame.waitForFunction(
      () => !!document.querySelector("#layer-list li.is-mask"),
      { timeout: 3000 },
    );
    ok("マスク指定ボタンで再指定できる", true);

    /* ========== 2) JSPAINT_EXPORT: 完了 → 親アプリへ送信 ========== */
    console.log("\n[JSPAINT_EXPORT]");
    await frame.click("#btn-export");
    await frame.waitForFunction(() => !(document.querySelector("#modal-export") as HTMLElement).hidden, { timeout: 5000 });
    await frame.click("#btn-postmessage");
    await page.waitForFunction(() => (window as any).exportMessage !== null, { timeout: 5000 });
    const msg = (await page.evaluate(() => (window as any).exportMessage)) as ExportMessage;
    ok("完了 → 親アプリへ送信 で JSPAINT_EXPORT が親に届く", !!msg?.compositeImage && !!msg?.maskImage);

    const checks = await page.evaluate(async (m: ExportMessage) => {
      const decode = (url: string) =>
        new Promise<HTMLImageElement>((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = rej;
          i.src = url;
        });
      const pixel = async (url: string, x: number, y: number) => {
        const img = await decode(url);
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const g = c.getContext("2d")!;
        g.drawImage(img, 0, 0);
        const d = g.getImageData(x, y, 1, 1).data;
        return [d[0], d[1], d[2], d[3]];
      };
      return {
        composite: await pixel(m.compositeImage, 4, 64), // 左端 = グラデーションの赤寄り
        maskLeft: await pixel(m.maskImage, 4, 64), // 白 (再生成) のはず
        maskRight: await pixel(m.maskImage, 252, 64), // 黒 (維持) のはず
      };
    }, msg);

    ok("compositeImage に元画像の内容が反映される (左端が赤系)", checks.composite[0] > 200, JSON.stringify(checks.composite));
    // マスク領域 (左半分) が compositeImage に白く焼き込まれていないこと
    ok("compositeImage にマスクが焼き込まれていない (左端が白濁していない)", checks.composite[1] < 150, JSON.stringify(checks.composite));
    ok("maskImage の左半分は白 (再生成)", checks.maskLeft[0] > 200 && checks.maskLeft[3] === 255, JSON.stringify(checks.maskLeft));
    ok("maskImage の右半分は黒 (維持)", checks.maskRight[0] < 50, JSON.stringify(checks.maskRight));
  } finally {
    await browser.close();
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
