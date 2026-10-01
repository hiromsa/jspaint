/**
 * scripts/verify-meshwarp.ts — メッシュワープの検証
 *
 * Part 1: 純粋ロジック (クーンズパッチ評価 / ド・カステリョ分割 / エッジ直接ドラッグ /
 *         パッチ分割 / 逆写像) を node 上で単体検証する (canvas 非依存)。
 * Part 2: 実ブラウザ E2E (ツールスタック選択 / セッション開始 / エッジドラッグ → 確定 /
 *         Undo / ダブルクリック細分化 / Esc 取消 / T キーでのパペット⇔メッシュトグル)。
 *
 * 実行: npm run test:meshwarp  (Part 2 は事前に npm run build 必須)
 * ブラウザ: インストール済みの Chrome / Edge を自動検出して使用
 */
import puppeteer, { type Page } from "puppeteer-core";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { MeshWarpGrid, bezierAt, deCasteljau, edgeDragWeights, subPt, addPt, lerpPt } from "../src/meshwarp/meshGrid";
import type { Pt } from "../src/core/types";

/* ================================================================== *
 * Part 1 — 純粋ロジックの単体検証 (node)
 * ================================================================== */

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const near = (a: number, b: number, eps = 1e-4): boolean => Math.abs(a - b) <= eps;
const nearPt = (p: Pt, q: Pt, eps = 1e-4): boolean => near(p.x, q.x, eps) && near(p.y, q.y, eps);

/* --- 1. 初期化: 4 ノード・1 パッチの矩形グリッド --- */
{
  const grid = MeshWarpGrid.createRect(10, 20, 110, 220);
  check("createRect: ノード数 4", grid.nodes.size === 4, `got ${grid.nodes.size}`);
  check("createRect: パッチ数 1", grid.patches.length === 1, `got ${grid.patches.length}`);
  check("createRect: 恒等変形", grid.isIdentity());
  const p = grid.patches[0];
  check("createRect: 四隅の home が矩形と一致", nearPt(grid.nodePos(p.tl, "home"), { x: 10, y: 20 }) && nearPt(grid.nodePos(p.br, "home"), { x: 110, y: 220 }));
}

/* --- 2. クーンズパッチ評価 (ハンドルなし = 双線形) --- */
{
  const grid = MeshWarpGrid.createRect(0, 0, 100, 100);
  const p = grid.patches[0];
  check("Coons: 四隅 TL でノードと一致", nearPt(grid.evaluatePatch(p, 0, 0, "pos"), { x: 0, y: 0 }));
  check("Coons: 四隅 BR でノードと一致", nearPt(grid.evaluatePatch(p, 1, 1, "pos"), { x: 100, y: 100 }));
  check("Coons: 中心 (0.5,0.5)", nearPt(grid.evaluatePatch(p, 0.5, 0.5, "pos"), { x: 50, y: 50 }));
  check("Coons: (0.25,0.75) = 双線形", nearPt(grid.evaluatePatch(p, 0.25, 0.75, "pos"), { x: 25, y: 75 }));
  // home / pos が同じなので両空間で同一
  check("Coons: home 空間も同一", nearPt(grid.evaluatePatch(p, 0.3, 0.6, "home"), grid.evaluatePatch(p, 0.3, 0.6, "pos")));
}

/* --- 3. ハンドル付きエッジの評価 (3 次ベジェと一致) --- */
{
  const grid = MeshWarpGrid.createRect(0, 0, 100, 100);
  const p = grid.patches[0];
  // 上エッジ (tl→tr) のハンドル: P1 = (30, -40) / P2 = (70, -40)
  grid.setHandle(p.tl, p.tr, { x: 30, y: -40 });
  grid.setHandle(p.tr, p.tl, { x: -30, y: -40 });
  const [q0, q1, q2, q3] = grid.edgePoints(grid.node(p.tl), grid.node(p.tr), "pos");
  check("Coons: ハンドル付き C_top(0.5) がベジェと一致", nearPt(grid.evaluateEdge(p.tl, p.tr, 0.5, "pos"), bezierAt(q0, q1, q2, q3, 0.5)));
  // 終端はノードのまま
  check("Coons: C_top(0) / C_top(1) はコーナー", nearPt(grid.evaluateEdge(p.tl, p.tr, 0, "pos"), { x: 0, y: 0 }) && nearPt(grid.evaluateEdge(p.tl, p.tr, 1, "pos"), { x: 100, y: 0 }));
  // Coons パッチの (u,0) は上エッジ上の点と一致 (パッチ境界 = エッジ曲線)
  check("Coons: パッチ境界 S(0.5,0) = C_top(0.5)", nearPt(grid.evaluatePatch(p, 0.5, 0, "pos"), grid.evaluateEdge(p.tl, p.tr, 0.5, "pos")));
}

/* --- 4. ド・カステリョ分割 (列挿入): 曲線形状の不変性 --- */
{
  const grid = MeshWarpGrid.createRect(0, 0, 200, 100);
  const p = grid.patches[0];
  grid.setHandle(p.tl, p.tr, { x: 60, y: -80 });
  grid.setHandle(p.tr, p.tl, { x: -20, y: -50 });

  // 分割前の上エッジ (曲線) の密サンプリングと制御点
  const dense = Array.from({ length: 201 }, (_, i) => grid.evaluateEdge(p.tl, p.tr, i / 200, "pos"));
  const denseHome = Array.from({ length: 101 }, (_, i) => grid.evaluateEdge(p.tl, p.tr, i / 100, "home"));
  const [p0, p1, p2, p3] = grid.edgePoints(grid.node(p.tl), grid.node(p.tr), "pos");

  grid.splitColumnAt(0, 0.37);
  check("splitColumn: 列が 1 つ増える (colCount 3)", grid.colCount === 3, `got ${grid.colCount}`);
  check("splitColumn: 全行に新ノードが挿入 (貫通)", grid.rows[0].length === 3 && grid.rows[1].length === 3);
  check("splitColumn: ノード追加 (4+2)", grid.nodes.size === 6, `got ${grid.nodes.size}`);
  check("splitColumn: パッチが 2 つに", grid.patches.length === 2, `got ${grid.patches.length}`);

  // 分割後の上エッジ (行 0 の 2 セグメント) の合成点列が、分割前の曲線上に載る
  const [tl, m, tr] = grid.rows[0];
  const afterSamples = [0.02, 0.15, 0.37, 0.5, 0.63, 0.86, 0.98].map((u) =>
    u <= 0.37 ? grid.evaluateEdge(tl, m, u / 0.37, "pos") : grid.evaluateEdge(m, tr, (u - 0.37) / 0.63, "pos"),
  );
  check("splitColumn: 分割後の曲線点が元曲線上に載る (pos)", afterSamples.every((a) => dense.some((d) => nearPt(d, a, 1e-6))));
  const afterHome = [0.2, 0.5, 0.8].map((u) =>
    u <= 0.37 ? grid.evaluateEdge(tl, m, u / 0.37, "home") : grid.evaluateEdge(m, tr, (u - 0.37) / 0.63, "home"),
  );
  check("splitColumn: 分割後の曲線点が元曲線上に載る (home)", afterHome.every((a) => denseHome.some((d) => nearPt(d, a, 1e-6))));

  // 新ノードのハンドル: 前半の L2 / 後半の R2 と一致する (仕様 4.2)。既存ノードのハンドルは部分曲線の制御点 (L1 / R1) へ更新される
  const dc = deCasteljau(p0, p1, p2, p3, 0.37);
  const [l1Pos, r1Pos] = [lerpPt(p0, p1, 0.37), lerpPt(p2, p3, 0.37)];
  check("splitColumn: 新ノード pos = C(t)", nearPt(grid.nodePos(m, "pos"), dc.c, 1e-9));
  const mn = grid.node(m);
  check("splitColumn: 新ハンドル = L2 - C / R2 - C", nearPt(mn.posHandles.get(p.tl)!, subPt(dc.l2, dc.c), 1e-9) && nearPt(mn.posHandles.get(p.tr)!, subPt(dc.r2, dc.c), 1e-9));
  // 両端ノードのハンドルは部分曲線の制御点 (L1 − P0 / R1 − P3) へ更新される (元曲線を継承)
  check("splitColumn: 両端ノードのハンドル = 部分曲線の制御点", nearPt(grid.node(tl).posHandles.get(m)!, subPt(l1Pos, p0), 1e-9) && nearPt(grid.node(tr).posHandles.get(m)!, subPt(r1Pos, p3), 1e-9));
}

/* --- 5. ライン追加はグリッド全体に貫通する --- */
{
  // 3x2 ノード (2x1 パッチ) まで細分化したグリッドを作る
  const grid = MeshWarpGrid.createRect(0, 0, 200, 100);
  grid.splitColumnAt(0, 0.5);
  check("貫通の前提: 2 列パッチ (3x2 ノード)", grid.colCount === 3 && grid.rowCount === 2 && grid.patches.length === 2);

  // 右パッチ内の点 (150, 50) をダブルクリック相当で分割 → ラインが左パッチにも貫通する
  const hit = grid.patchAt({ x: 150, y: 50 });
  check("貫通: 右パッチ内の点を特定", !!hit);
  grid.splitPatchAt(hit!.patch, hit!.u, hit!.v);
  check("貫通: 列挿入で colCount 4 / 行挿入で rowCount 3", grid.colCount === 4 && grid.rowCount === 3, `cols=${grid.colCount} rows=${grid.rowCount}`);
  check("貫通: パッチ数 6 (3x2)", grid.patches.length === 6, `got ${grid.patches.length}`);
  check("貫通: ノード数 12", grid.nodes.size === 12, `got ${grid.nodes.size}`);
}

/* --- 6. パッチの縦横ライン分割 (splitPatchAt) --- */
{
  const grid = MeshWarpGrid.createRect(0, 0, 100, 100);
  const p = grid.patches[0];
  grid.splitPatchAt(p, 0.5, 0.5);
  check("splitPatch: 1 パッチ → 4 パッチ", grid.patches.length === 4, `got ${grid.patches.length}`);
  check("splitPatch: ノード数 9 (4+4+1)", grid.nodes.size === 9, `got ${grid.nodes.size}`);
  // 直線エッジ (双線形) のとき、分割パッチの評価は元パッチの対応位置と一致する
  const q = grid.patches[0]; // TL パッチ
  check("splitPatch: TL パッチ中心 = 元パッチ (0.25,0.25)", nearPt(grid.evaluatePatch(q, 0.5, 0.5, "pos"), { x: 25, y: 25 }, 1e-6));
  const brPatch = grid.patches[3];
  check("splitPatch: BR パッチ中心 = 元パッチ (0.75,0.75)", nearPt(grid.evaluatePatch(brPatch, 0.5, 0.5, "pos"), { x: 75, y: 75 }, 1e-6));
  // 行列の全ノードが nodes に存在し、パッチの 4 辺はコーナーで閉じる
  const allKnown = grid.rows.flat().every((id) => grid.nodes.has(id));
  const closed = grid.patches.every((pa) =>
    pa.top[0] === pa.tl && pa.top[pa.top.length - 1] === pa.tr &&
    pa.right[0] === pa.tr && pa.right[pa.right.length - 1] === pa.br &&
    pa.bottom[0] === pa.bl && pa.bottom[pa.bottom.length - 1] === pa.br &&
    pa.left[0] === pa.tl && pa.left[pa.left.length - 1] === pa.bl);
  check("splitPatch: 全パッチの辺がコーナーで閉じる", closed && allKnown);
}

/* --- 6b. 行挿入 (splitRowAt) と clone --- */
{
  const grid = MeshWarpGrid.createRect(0, 0, 100, 100);
  grid.splitRowAt(0, 0.25);
  check("splitRow: 行が 1 つ増える (rowCount 3)", grid.rowCount === 3, `got ${grid.rowCount}`);
  check("splitRow: 全列に新ノード (貫通)", grid.rows[1].length === 2 && grid.patches.length === 2);
  // 挿入位置: t=0.25 なので新行の y = 25
  const mid = grid.nodePos(grid.rows[1][0], "pos");
  check("splitRow: 新行の位置 = home / pos とも t 地点", nearPt(mid, { x: 0, y: 25 }, 1e-9));

  // clone: 深いコピーで独立していること (セッション内 Undo の前提)
  const snapshot = grid.clone();
  grid.moveNode(grid.rows[1][1], { x: 50, y: 50 });
  check("clone: スナップショットは元の変更の影響を受けない", nearPt(snapshot.nodePos(snapshot.rows[1][1], "pos"), { x: 100, y: 25 }));
  check("clone: 行列・ノード数が一致", snapshot.colCount === grid.colCount && snapshot.rowCount === grid.rowCount && snapshot.nodes.size === grid.nodes.size);
}

/* --- 7. エッジ直接ドラッグ (仕様 4.3): カーブ点がマウスに吸いつく --- */
{
  const grid = MeshWarpGrid.createRect(0, 0, 200, 100);
  const p = grid.patches[0];
  const hit = grid.hitEdge({ x: 100, y: 0 }, 5);
  check("hitEdge: 直線エッジ上を検出", !!hit && near(hit!.t, 0.5, 0.05), hit ? `t=${hit.t}` : "null");
  const drag = grid.beginEdgeDrag(hit!, { x: 100, y: 0 });
  const [q0, q1, q2, q3] = grid.edgePoints(grid.node(drag.aId), grid.node(drag.bId), "pos");
  const c0 = bezierAt(q0, q1, q2, q3, hit!.t);
  grid.applyEdgeDrag(drag, { x: 120, y: -50 });
  const [r0, r1, r2, r3] = grid.edgePoints(grid.node(drag.aId), grid.node(drag.bId), "pos");
  const c1 = bezierAt(r0, r1, r2, r3, hit!.t);
  check("edgeDrag: ドラッグ点が ΔD 平行移動 (吸いつき)", nearPt(c1, addPt(c0, { x: 20, y: -50 }), 1e-6));
  const { w1, w2 } = edgeDragWeights(drag.b1, drag.b2);
  check("edgeDrag: t=0.5 で重みが対称 (B1 = B2)", near(w1, w2, 1e-9) && w1 > 1);
  check("edgeDrag: home ハンドルは不変", grid.node(drag.aId).homeHandles.size === 0);
}

/* --- 8. 逆写像 (ニュートン反復) --- */
{
  const grid = MeshWarpGrid.createRect(0, 0, 100, 80);
  const p = grid.patches[0];
  grid.setHandle(p.tl, p.tr, { x: 30, y: -40 });
  grid.setHandle(p.tr, p.tl, { x: -30, y: -40 });
  let roundtrip = true;
  for (const [u, v] of [[0.2, 0.3], [0.5, 0.5], [0.8, 0.7], [0.35, 0.85]]) {
    const s = grid.evaluatePatch(p, u, v, "pos");
    const inv = grid.invertPatch(p, s, "pos");
    if (!near(inv.u, u, 1e-3) || !near(inv.v, v, 1e-3)) roundtrip = false;
  }
  check("invertPatch: (u,v) の往復が 1e-3 以内で復元", roundtrip);
  const hit = grid.patchAt(grid.evaluatePatch(p, 0.6, 0.4, "pos"));
  check("patchAt: クーンズ内部点を特定", !!hit && near(hit.u, 0.6, 1e-3) && near(hit.v, 0.4, 1e-3));
  check("patchAt: グリッド外は null", grid.patchAt({ x: 500, y: 500 }) === null);
}

/* --- 9. 変形操作と恒等判定 --- */
{
  const grid = MeshWarpGrid.createRect(0, 0, 100, 100);
  const p = grid.patches[0];
  grid.moveNode(p.tl, { x: 10, y: -20 });
  check("moveNode: pos のみ移動 (home 不変)", nearPt(grid.nodePos(p.tl, "pos"), { x: 10, y: -20 }) && nearPt(grid.nodePos(p.tl, "home"), { x: 0, y: 0 }));
  check("isIdentity: 変形後は false", !grid.isIdentity());
  // ハンドルは相対ベクトルなので、ノード移動でエッジ全体が平行移動する
  grid.setHandle(p.tl, p.tr, { x: 30, y: -30 });
  const [a0, a1, , a3] = grid.edgePoints(grid.node(p.tl), grid.node(p.tr), "pos");
  grid.moveNode(p.tl, { x: 5, y: 5 });
  const [b0, b1, , b3] = grid.edgePoints(grid.node(p.tl), grid.node(p.tr), "pos");
  check("moveNode: ハンドルも平行移動", nearPt(subPt(b1, a1), { x: 5, y: 5 }) && nearPt(subPt(b0, a0), { x: 5, y: 5 }) && nearPt(a3, b3));
}

/* ================================================================== *
 * Part 2 — 実ブラウザ E2E
 * ================================================================== */

/* --- 使用ブラウザの解決 (verify-filterpen.ts と同じ候補) --- */
const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

/** dist/index.html は npm run の実行ディレクトリ (プロジェクトルート) 基準で探す */
const distFile = path.resolve(process.cwd(), "dist", "index.html");

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
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

/** #view 上のドキュメント中心基準オフセット (画面px) の 1px の色を取得する */
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

/** ツールスタックのメインボタンが示す選択中ツール */
async function stackMainTool(page: Page): Promise<string> {
  return page.$eval('[data-stack="puppet-warp,mesh-warp"] > .toolbtn', (el) => (el as HTMLElement).dataset.tool ?? "");
}

/** view 上で dblclick を発火する (puppeteer の clickCount: 2 は dblclick を合成しないため直接 dispatch) */
async function doubleClick(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.evaluate((x, y) => {
    document.querySelector("#view")!.dispatchEvent(new MouseEvent("dblclick", { clientX: x, clientY: y, bubbles: true }));
  }, x, y);
}

async function main(): Promise<void> {
  console.log(`\n[Part 1] pure logic: ${pass} passed, ${fail} failed`);
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
    console.log("\n[Part 2] browser E2E");
    const page = await browser.newPage();
    page.on("console", (msg) => console.log(`  [browser] ${msg.text()}`));
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`${fileUrl}?mode=standalone`);
    await page.waitForSelector("#layer-list li");
    await new Promise((r) => setTimeout(r, 300));

    // fit 表示: view 中心 = ドキュメント中心。ズームはヘッダー表示から取得
    const box = (await (await page.$("#view")).boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const zoom = parseFloat((await page.$eval("#ws-zoom", (el) => el.textContent ?? "100%")) || "100") / 100;
    // ドキュメント座標 → 画面座標 (中心基準)
    const sx = (x: number): number => cx + (x - 320) * zoom;
    const sy = (y: number): number => cy + (y - 320) * zoom;

    const baseline = await viewPixel(page, 0, 0);

    /* --- スタックからメッシュワープを選択 → セッション開始 --- */
    await page.click('[data-stack="puppet-warp,mesh-warp"] .toolstack__caret');
    await page.click('[data-stack="puppet-warp,mesh-warp"] .toolstack__pop [data-tool="mesh-warp"]');
    await new Promise((r) => setTimeout(r, 200));
    ok("スタックポップから mesh-warp を選択できる", (await stackMainTool(page)) === "mesh-warp");
    ok("セッション開始の案内トースト", (await lastToast(page)).includes("ノード / ハンドル / 辺をドラッグで変形"));
    ok("ツールタブにメッシュワープ用の確定ボタンが表示", await page.$eval("#btn-meshwarp-apply", (el) => (el as HTMLElement).offsetParent !== null));

    /* --- 上エッジ中央を上へドラッグ → エッジの直接変形 --- */
    await page.mouse.move(sx(320), sy(0));
    await page.mouse.down();
    await page.mouse.move(sx(320), sy(0) - 60, { steps: 10 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 250));

    // セッション中 (確定前) も変形プレビューが表示される
    const preview = await viewPixel(page, 0, 0);
    ok("ドラッグ後 (セッション中) に変形プレビューが表示される", colorDiff(baseline, preview) > 4, `diff=${colorDiff(baseline, preview)}`);

    /* --- Ctrl+Z でセッション内 Undo / Ctrl+Y で Redo --- */
    await page.keyboard.down("Control");
    await page.keyboard.press("z");
    await page.keyboard.up("Control");
    await new Promise((r) => setTimeout(r, 250));
    const sessionUndone = await viewPixel(page, 0, 0);
    ok("Ctrl+Z でセッション内の 1 操作を取り消し (元画像に戻る)", colorDiff(baseline, sessionUndone) <= 2, `diff=${colorDiff(baseline, sessionUndone)}`);

    await page.keyboard.down("Control");
    await page.keyboard.press("y");
    await page.keyboard.up("Control");
    await new Promise((r) => setTimeout(r, 250));
    const sessionRedone = await viewPixel(page, 0, 0);
    ok("Ctrl+Y でセッション内の操作をやり直し", colorDiff(baseline, sessionRedone) > 4, `diff=${colorDiff(baseline, sessionRedone)}`);

    /* --- Enter で確定 → レイヤーに焼き込まれる --- */
    await page.keyboard.press("Enter");
    await new Promise((r) => setTimeout(r, 250));
    // ツールを離れるとオーバーレイが消える (離脱時に自動確定済み) ので brush へ切り替える
    await page.click('[data-tool="brush"]');
    await new Promise((r) => setTimeout(r, 200));
    const after = await viewPixel(page, 0, 0);
    ok("エッジ変形の確定でドキュメント中心のピクセルが変化", colorDiff(baseline, after) > 4, `diff=${colorDiff(baseline, after)}`);

    /* --- Ctrl+Z (ドキュメント履歴) で元に戻る --- */
    await page.keyboard.down("Control");
    await page.keyboard.press("z");
    await page.keyboard.up("Control");
    await new Promise((r) => setTimeout(r, 250));
    const undone = await viewPixel(page, 0, 0);
    ok("確定後に Ctrl+Z (ドキュメント履歴) で元画像に戻る", colorDiff(baseline, undone) <= 2, `diff=${colorDiff(baseline, undone)}`);

    /* --- 再選択 → 上エッジダブルクリックでライン追加 (ノードのない位置) --- */
    await page.click('[data-stack="puppet-warp,mesh-warp"] .toolstack__caret');
    await page.click('[data-stack="puppet-warp,mesh-warp"] .toolstack__pop [data-tool="mesh-warp"]');
    await new Promise((r) => setTimeout(r, 200));
    await doubleClick(page, sx(320), sy(0));
    await new Promise((r) => setTimeout(r, 200));
    ok("エッジダブルクリックでラインを追加 (全体に貫通)", (await lastToast(page)).includes("ラインを追加しました"), `toast=${await lastToast(page)}`);

    /* --- 右上パッチ内ダブルクリックで縦横ライン追加 (ライン上でない位置) --- */
    await doubleClick(page, sx(480), sy(160));
    await new Promise((r) => setTimeout(r, 200));
    ok("パッチ内ダブルクリックで縦横ラインを追加 (全体に貫通)", (await lastToast(page)).includes("縦横のラインを追加しました"), `toast=${await lastToast(page)}`);

    /* --- Esc で取消 --- */
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 200));
    ok("Esc で取消トースト", (await lastToast(page)).includes("メッシュワープを取消"));
    const canceled = await viewPixel(page, 0, 0);
    ok("取消で画像は変化しない", colorDiff(baseline, canceled) <= 2);

    /* --- T キーでパペット ⇔ メッシュワープを相互切替 --- */
    await page.keyboard.press("t");
    await new Promise((r) => setTimeout(r, 150));
    ok("T キー (mesh-warp 選択中) でパペットワープへ切替", (await stackMainTool(page)) === "puppet-warp");
    await page.keyboard.press("t");
    await new Promise((r) => setTimeout(r, 150));
    ok("T キー (puppet-warp 選択中) でメッシュワープへ切替", (await stackMainTool(page)) === "mesh-warp");
    await page.keyboard.press("Escape");
  } finally {
    await browser.close();
  }

  console.log(`\n[Result] ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
