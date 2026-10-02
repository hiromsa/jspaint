/**
 * scripts/verify-puppet.ts — パペットワープの検証
 *
 * Part 1: 純粋ロジック (Delaunay / メッシュ生成 / MLS 変形) を node 上で単体検証する
 *         (canvas 非依存)。
 * Part 2: 実ブラウザ E2E — セッション内 Undo / Redo (Ctrl+Z / Ctrl+Y とヘッダーボタン) と
 *         反映方法 (上書き / 置換 / 新規レイヤー) を検証する。
 *
 * 実行: npm run test:puppet  (Part 2 は事前に npm run build 必須)
 * ブラウザ: インストール済みの Chrome / Edge を自動検出して使用
 */
import puppeteer, { type Page } from "puppeteer-core";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { regionBounds } from "../src/core/canvasUtils";
import { triangulate } from "../src/puppet/delaunay";
import { buildMesh, inverseDeformPoint } from "../src/puppet/mesh";
import { computeDeformedVertices } from "../src/puppet/deformer";
import type { Pt } from "../src/core/types";

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

/* --- 1. Delaunay: 正方形 4 点 --- */
{
  const pts: Pt[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const tris = triangulate(pts);
  check("Delaunay: 正方形4点 → 2三角形", tris.length === 2, `got ${tris.length}`);
  // 正方形の対角線はどちらを選んでも Delaunay として合法 (退化) なため、
  // 4 頂点がすべて使用されることのみ検証する
  const used = new Set(tris.flat());
  check("Delaunay: 対角線の向きに関わらず4頂点すべて使用", used.size === 4, [...used].join(","));
}

/* --- 2. Delaunay: グリッド点群の面積保存 --- */
{
  const pts: Pt[] = [];
  for (let y = 0; y <= 4; y++) for (let x = 0; x <= 4; x++) pts.push({ x: x * 10, y: y * 10 });
  const tris = triangulate(pts);
  check("Delaunay: 5x5グリッド → 32三角形", tris.length === 32, `got ${tris.length}`);
  const area = tris.reduce((s, [a, b, c]) => {
    const p = pts[a], q = pts[b], r = pts[c];
    return s + Math.abs((q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y)) / 2;
  }, 0);
  check("Delaunay: 三角形面積の合計 = 凸包面積 (1600)", near(area, 1600, 1e-6), `got ${area}`);
}

/* --- 3. Delaunay: ランダム点群 (シード固定) の位相整合性 --- */
{
  let seed = 12345;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pts: Pt[] = [];
  for (let i = 0; i < 200; i++) pts.push({ x: rnd() * 500, y: rnd() * 500 });
  const tris = triangulate(pts);
  const edgeCount = new Map<string, number>();
  for (const [a, b, c] of tris) {
    for (const [p, q] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const k = p < q ? `${p},${q}` : `${q},${p}`;
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
    }
  }
  check("Delaunay: 200点ランダム — どの辺も2三角形以下で共有", [...edgeCount.values()].every((c) => c <= 2));
}

/* --- 4. メッシュ生成: 矩形領域 --- */
{
  const contains = (x: number, y: number): boolean => x >= 100 && x < 200 && y >= 80 && y < 180;
  const b = regionBounds(contains, 400, 400);
  check("regionBounds: 外接矩形", !!b && b.x0 === 100 && b.y0 === 80 && b.x1 === 199 && b.y1 === 179);
  const mesh = buildMesh(contains, 32, 400, 400);
  check("buildMesh: メッシュ生成 (頂点4+/三角形2+)", !!mesh && mesh.vertices.length >= 4 && mesh.triangles.length >= 2);
  check("buildMesh: 初期ピンは空", !!mesh && mesh.pins.length === 0);
  const inBox = !!mesh && mesh.vertices.every((v) => v.x >= 30 && v.x <= 270 && v.y >= 10 && v.y <= 250);
  check("buildMesh: 頂点は領域近傍 (±~70px) に収まる", inBox);
  const uniq = !!mesh && new Set(mesh.vertices.map((v) => `${v.x},${v.y}`)).size === mesh.vertices.length;
  check("buildMesh: 頂点に重複がない", uniq);
}

/* --- 4b. メッシュ生成: 640 を超える領域 (可変ドキュメント) --- */
{
  const contains = (x: number, y: number): boolean => x >= 700 && x < 900 && y >= 600 && y < 800;
  const b = regionBounds(contains, 1000, 1000);
  check("regionBounds: 640超の領域の外接矩形", !!b && b.x0 === 700 && b.y0 === 600 && b.x1 === 899 && b.y1 === 799);
  const mesh = buildMesh(contains, 32, 1000, 1000);
  const inBox = !!mesh && mesh.vertices.every((v) => v.x >= 630 && v.x <= 970 && v.y >= 530 && v.y <= 870);
  check("buildMesh: 640超の領域もメッシュ化できる (頂点が領域近傍に収まる)", !!mesh && mesh.triangles.length >= 2 && inBox);
  const covered = !!mesh && mesh.vertices.some((v) => v.x > 700 && v.y > 700);
  check("buildMesh: 640超の位置に頂点が存在する", covered);
}

/* --- 5. メッシュ生成: 空領域 --- */
{
  check("buildMesh: 空領域 → null", buildMesh(() => false, 32, 400, 400) === null);
  check("regionBounds: 空領域 → null", regionBounds(() => false, 400, 400) === null);
}

/* --- 6. MLS: ピン 0 個は恒等変形 --- */
{
  const mesh = buildMesh((x, y) => x >= 100 && x < 200 && y >= 80 && y < 180, 64, 400, 400);
  if (!mesh) throw new Error("buildMesh failed");
  const out = computeDeformedVertices(mesh);
  const identity = out.every((v, i) => near(v.x, mesh.vertices[i].x, 1e-9) && near(v.y, mesh.vertices[i].y, 1e-9));
  check("MLS: ピン0個 → 恒等変形", identity);
}

/* --- 7. MLS: 1 ピンの平行移動 --- */
{
  const mesh = buildMesh((x, y) => x >= 100 && x < 200 && y >= 80 && y < 180, 64, 400, 400);
  if (!mesh) throw new Error("buildMesh failed");
  mesh.pins.push({ id: 1, original: { x: 150, y: 130 }, current: { x: 170, y: 150 }, isPinned: false });
  const out = computeDeformedVertices(mesh);
  const first = out[0];
  check(
    "MLS: 1ピン(+20,+20) → 全頂点が平行移動",
    out.every((v, i) => near(v.x - mesh.vertices[i].x, 20) && near(v.y - mesh.vertices[i].y, 20)),
    `first (${first.x.toFixed(3)}, ${first.y.toFixed(3)}) expected (${mesh.vertices[0].x + 20}, ${mesh.vertices[0].y + 20})`,
  );
}

/* --- 8. MLS: 2 ピンの 90° 回転 (原点中心) --- */
{
  const mesh = {
    vertices: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }],
    triangles: [{ indices: [0, 1, 2] }],
    pins: [
      { id: 1, original: { x: 0, y: 0 }, current: { x: 0, y: 0 }, isPinned: true },
      { id: 2, original: { x: 4, y: 0 }, current: { x: 0, y: 4 }, isPinned: false },
    ],
  };
  const out = computeDeformedVertices(mesh);
  check("MLS: 90°回転 — 原点ピン上の頂点は不動", near(out[0].x, 0, 0.01) && near(out[0].y, 0, 0.01), `got (${out[0].x}, ${out[0].y})`);
  check("MLS: 90°回転 — (2,0) → (0,2)", near(out[1].x, 0, 0.02) && near(out[1].y, 2, 0.02), `got (${out[1].x}, ${out[1].y})`);
}

/* --- 9. MLS: アンカー (未移動ピンのそばはほぼ動かない / 移動ピン方向へ引っ張られる) --- */
{
  const mesh = {
    vertices: [{ x: 10, y: 10 }, { x: 100, y: 100 }],
    triangles: [{ indices: [0, 1, 0] }],
    pins: [
      { id: 1, original: { x: 10, y: 10 }, current: { x: 10, y: 10 }, isPinned: true },
      { id: 2, original: { x: 100, y: 100 }, current: { x: 150, y: 100 }, isPinned: false },
    ],
  };
  const out = computeDeformedVertices(mesh);
  // MLS rigid では剛体 (回転のみ) で近似するため、移動ピン位置そのものへは一致しない。
  // 固定ピンはほぼ不動であること、移動ピンが右 (+x) へ引っ張られることを検証する
  const anchorDrift = Math.hypot(out[0].x - 10, out[0].y - 10);
  check("MLS: 未移動ピン上の頂点はほぼ不動 (<5px)", anchorDrift < 5, `drift ${anchorDrift.toFixed(3)}`);
  check("MLS: 移動ピン側の頂点は右 (+x) へ引っ張られる", out[1].x > 110, `got (${out[1].x.toFixed(1)}, ${out[1].y.toFixed(1)})`);
}

/* --- 10. 逆変換 (変形後空間 → 初期空間): 変形済み状態でのピン打ち --- */
{
  const contains = (x: number, y: number): boolean => x >= 100 && x < 200 && y >= 80 && y < 180;
  const mesh = buildMesh(contains, 32, 400, 400);
  if (!mesh) throw new Error("buildMesh failed");
  const identity = computeDeformedVertices(mesh);
  const p = inverseDeformPoint(mesh, identity, { x: 150, y: 120 });
  check("逆変換: 恒等変形では元の座標に戻る", near(p.x, 150, 1e-6) && near(p.y, 120, 1e-6), `got (${p.x}, ${p.y})`);

  // 1 ピン平行移動 (+20,+20) — 変形は正確な平行移動 (テスト7で検証済み)
  mesh.pins.push({ id: 1, original: { x: 150, y: 130 }, current: { x: 170, y: 150 }, isPinned: false });
  const shifted = computeDeformedVertices(mesh);
  const q = inverseDeformPoint(mesh, shifted, { x: 160, y: 130 });
  check("逆変換: (+20,+20) 平行移動を打ち消す", near(q.x, 140, 0.5) && near(q.y, 110, 0.5), `got (${q.x.toFixed(2)}, ${q.y.toFixed(2)})`);

  // 【核心】変形後空間にピンを打っても既存変形がほぼ変わらないこと (original = 逆変換結果)
  const before = computeDeformedVertices(mesh);
  mesh.pins.push({
    id: 2,
    original: inverseDeformPoint(mesh, before, { x: 120, y: 100 }),
    current: { x: 120, y: 100 },
    isPinned: true,
  });
  const after = computeDeformedVertices(mesh);
  let maxDrift = 0;
  for (let i = 0; i < before.length; i++) {
    maxDrift = Math.max(maxDrift, Math.hypot(after[i].x - before[i].x, after[i].y - before[i].y));
  }
  check("逆変換: 変形後空間に打った固定ピンで変形がほぼ不変 (<1px)", maxDrift < 1, `maxDrift ${maxDrift.toFixed(4)}`);

  // メッシュ外の点は入力をそのまま返す
  const outside = inverseDeformPoint(mesh, shifted, { x: 10, y: 10 });
  check("逆変換: メッシュ外は入力と同じ座標を返す", outside.x === 10 && outside.y === 10);
}

/* ================================================================== *
 * Part 2 — 実ブラウザ E2E (セッション内 Undo / Redo + 反映方法)
 * ================================================================== */

/* --- 使用ブラウザの解決 (verify-meshwarp.ts と同じ候補) --- */
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 直近の toast メッセージ全文を取得する */
async function lastToast(page: Page): Promise<string> {
  return page.evaluate(() => {
    const toasts = document.querySelectorAll("#toasts .toast");
    return toasts.length ? (toasts[toasts.length - 1] as HTMLElement).textContent ?? "" : "";
  });
}

/** カーソルを動かさずに view 中心基準オフセット (画面px) の 1px を読む (ドラッグ中のプレビュー検証用) */
function readPixel(page: Page, dx: number, dy: number): Promise<[number, number, number]> {
  return page.evaluate((dx, dy) => {
    const view = document.querySelector("#view") as HTMLCanvasElement;
    const d = view.getContext("2d")!.getImageData(Math.round(view.width / 2) + dx, Math.round(view.height / 2) + dy, 1, 1).data;
    return [d[0], d[1], d[2]];
  }, dx, dy);
}

/** #view 上のドキュメント中心基準オフセット (画面px) の 1px の色を取得する (カーソルを view 外へ退避) */
async function viewPixel(page: Page, dx: number, dy: number): Promise<[number, number, number]> {
  const box = (await (await page.$("#view")).boundingBox())!;
  await page.mouse.move(box.x - 40, box.y - 40);
  await sleep(120);
  return readPixel(page, dx, dy);
}

function colorDiff(a: [number, number, number], b: [number, number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

async function undoBtnEnabled(page: Page): Promise<boolean> {
  return page.$eval("#btn-undo", (el) => !(el as HTMLButtonElement).disabled);
}

async function layerCount(page: Page): Promise<number> {
  return page.$$eval("#layer-list li", (els) => els.length);
}

async function activeLayerName(page: Page): Promise<string> {
  return page.$eval("#layer-list li.is-active .layer__name", (el) => el.textContent ?? "");
}

/** Ctrl+Z / Ctrl+Y を送る */
async function undoKeys(page: Page): Promise<void> {
  await page.keyboard.down("Control");
  await page.keyboard.press("z");
  await page.keyboard.up("Control");
}

async function redoKeys(page: Page): Promise<void> {
  await page.keyboard.down("Control");
  await page.keyboard.press("y");
  await page.keyboard.up("Control");
}

/**
 * ツールスタックからパペットワープを選択し、「下半分を選択した状態」でセッションを開始する。
 */
async function startPuppetWarpWithSelection(page: Page, sx: (x: number) => number, sy: (y: number) => number): Promise<void> {
  // 下半分を矩形選択
  await page.click('[data-tool="select-rect"]');
  await page.mouse.move(sx(0), sy(321));
  await page.mouse.down();
  await page.mouse.move(sx(640), sy(640), { steps: 6 });
  await page.mouse.up();
  await sleep(200);
  // スタックポップからパペットワープを選択 → セッション開始
  await page.click('[data-stack="puppet-warp,mesh-warp"] .toolstack__caret');
  await page.click('[data-stack="puppet-warp,mesh-warp"] .toolstack__pop [data-tool="puppet-warp"]');
  await sleep(250);
}

/**
 * ピン (320,480) を打って (320,350) へドラッグする共通操作。
 * MLS rigid (Part 1 検証済み: 1 ピン → 全頂点が平行移動) により画像が上へ平行移動し、
 * 選択範囲の下側に「ワープで画像が無くなる部分」が生じる。
 */
async function dragPuppetPin(page: Page, sx: (x: number) => number, sy: (y: number) => number): Promise<void> {
  // ピンを打ち、押したまま上へドラッグ (クリック=ピン追加 + そのままドラッグで調整)
  await page.mouse.move(sx(320), sy(480));
  await page.mouse.down();
  await page.mouse.move(sx(320), sy(350), { steps: 10 });
  await page.mouse.up();
  await sleep(250);
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
    await sleep(300);

    // fit 表示: view 中心 = ドキュメント中心 (320, 320)。ズームはヘッダー表示から取得
    const box = (await (await page.$("#view")).boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const zoom = parseFloat((await page.$eval("#ws-zoom", (el) => el.textContent ?? "100%")) || "100") / 100;
    const sx = (x: number): number => cx + (x - 320) * zoom;
    const sy = (y: number): number => cy + (y - 320) * zoom;

    // セッション中はピン / メッシュ線のオーバーレイが画像に重なるため、検証は
    // 複数プローブ点で baseline との色差の最小値 (オーバーレイのない点を採用) を取る
    const PROBES: Array<[number, number]> = [[480, 480], [470, 465], [492, 492], [455, 485], [486, 452], [508, 505], [440, 440]];
    const rp = (x: number, y: number) => readPixel(page, (x - 320) * zoom, (y - 320) * zoom);
    await page.mouse.move(box.x - 40, box.y - 40);
    await sleep(150);
    const base = new Map<string, [number, number, number]>();
    for (const [x, y] of PROBES) base.set(`${x},${y}`, await rp(x, y));
    const minBaseDiff = async (): Promise<number> => {
      let min = Infinity;
      for (const [x, y] of PROBES) min = Math.min(min, colorDiff(base.get(`${x},${y}`)!, await rp(x, y)));
      return min;
    };
    const maxBaseDiff = async (): Promise<number> => {
      let max = 0;
      for (const [x, y] of PROBES) max = Math.max(max, colorDiff(base.get(`${x},${y}`)!, await rp(x, y)));
      return max;
    };

    /* --- T キーでパペットワープ → セッション開始 --- */
    await page.keyboard.press("t");
    await sleep(250);
    ok("T キーでパペットワープのセッションを開始", (await lastToast(page)).includes("ピンを打ってドラッグで変形"), `toast=${await lastToast(page)}`);
    ok("セッション開始直後はヘッダー Undo ボタンが無効", !(await undoBtnEnabled(page)));

    /* --- ピンドラッグ → ドラッグ中プレビュー + セッション内履歴 --- */
    await page.mouse.move(sx(320), sy(320));
    await page.mouse.down();
    await page.mouse.move(sx(320), sy(200), { steps: 8 });
    await sleep(220);
    const duringDiff = colorDiff(base.get("480,480")!, await rp(480, 480));
    ok("ピンドラッグ中に変形プレビューが表示される", duringDiff > 4, `diff=${duringDiff}`);
    ok("操作後にヘッダー Undo ボタンが有効", await undoBtnEnabled(page));
    await page.mouse.up();
    await sleep(250);

    /* --- Ctrl+Z でセッション内 Undo / Ctrl+Y で Redo --- */
    await undoKeys(page);
    await sleep(250);
    const undoneDiff = await minBaseDiff();
    ok("Ctrl+Z でセッション内の 1 操作を取り消し (元画像に戻る)", undoneDiff <= 6, `diff=${undoneDiff}`);
    await redoKeys(page);
    await sleep(250);
    const redoneDiff = await maxBaseDiff();
    ok("Ctrl+Y でセッション内の操作をやり直し", redoneDiff > 4, `diff=${redoneDiff}`);

    /* --- ヘッダーの Undo / Redo ボタンでもセッション内履歴を操作できる --- */
    await page.click("#btn-undo");
    await sleep(250);
    const headerUndoneDiff = await minBaseDiff();
    ok("ヘッダー Undo ボタンでセッション内の操作を取り消し", headerUndoneDiff <= 6, `diff=${headerUndoneDiff}`);
    await page.click("#btn-redo");
    await sleep(250);
    const headerRedoneDiff = await maxBaseDiff();
    ok("ヘッダー Redo ボタンでセッション内の操作をやり直し", headerRedoneDiff > 4, `diff=${headerRedoneDiff}`);

    /* --- 2 つ目のピン (追加・ドラッグ・削除もセッション内履歴に載る) --- */
    // 1 つ目のドラッグ状態 (現在) のプローブ値を保持しておく。
    // 1 つ目の変形は平行移動のため、画面位置に打った 2 つ目のピン (original = 変形前空間 /
    // current = 画面位置) の制約は既存の変形に整合し、追加だけでは画像が変わらない
    const firstDrag = new Map<string, [number, number, number]>();
    for (const [x, y] of PROBES) firstDrag.set(`${x},${y}`, await rp(x, y));
    const maxDiffTo = async (ref: Map<string, [number, number, number]>): Promise<number> => {
      let max = 0;
      for (const [x, y] of PROBES) max = Math.max(max, colorDiff(ref.get(`${x},${y}`)!, await rp(x, y)));
      return max;
    };
    await page.mouse.click(sx(420), sy(420)); // ピン追加のみ (画像は不変)
    await sleep(250);
    const pinAddedDiff = await maxDiffTo(firstDrag);
    ok("2 つ目のピンの追加だけでは画像が変わらない", pinAddedDiff <= 6, `diff=${pinAddedDiff}`);
    await page.mouse.move(sx(420), sy(420));
    await page.mouse.down();
    await page.mouse.move(sx(500), sy(480), { steps: 6 });
    await page.mouse.up();
    await sleep(250);
    const secondDrag = new Map<string, [number, number, number]>();
    for (const [x, y] of PROBES) secondDrag.set(`${x},${y}`, await rp(x, y));
    const secondDragDiff = await maxDiffTo(firstDrag);
    ok("2 つ目のピンのドラッグで画像がさらに変化", secondDragDiff > 4, `diff=${secondDragDiff}`);
    await undoKeys(page); // 2 つ目のドラッグを戻す (ピン 2 は打った位置に残り、画像は 1 つ目の変形へ)
    await sleep(250);
    const secondDragUndone = await maxDiffTo(firstDrag);
    ok("Undo で 2 つ目のピンのドラッグを取り消し", secondDragUndone <= 6, `diff=${secondDragUndone}`);
    await undoKeys(page); // 2 つ目のピン追加を戻す (画像は不変)
    await sleep(250);
    const secondPinUndone = await maxDiffTo(firstDrag);
    ok("Undo の 2 回目で 2 つ目のピン追加を取り消し", secondPinUndone <= 6, `diff=${secondPinUndone}`);
    await redoKeys(page); // 2 つ目のピン追加をやり直し (画像は不変)
    await sleep(250);
    const secondPinRedone = await maxDiffTo(firstDrag);
    ok("Redo で 2 つ目のピン追加をやり直し", secondPinRedone <= 6, `diff=${secondPinRedone}`);
    await redoKeys(page); // 2 つ目のドラッグをやり直し
    await sleep(250);
    const secondDragRedone = await maxDiffTo(secondDrag);
    ok("Redo の 2 回目で 2 つ目のピンのドラッグをやり直し", secondDragRedone <= 6, `diff=${secondDragRedone}`);

    /* --- Enter で確定 → ドキュメント履歴で戻る --- */
    await page.keyboard.press("Enter");
    await sleep(250);
    await page.click('[data-tool="brush"]');
    await sleep(200);
    const committedDiff = await maxBaseDiff();
    ok("Enter 確定で変形がレイヤーに焼き込まれる", committedDiff > 4, `diff=${committedDiff}`);
    await undoKeys(page);
    await sleep(250);
    const docUndoneDiff = await minBaseDiff();
    ok("確定後の Ctrl+Z (ドキュメント履歴) で元画像に戻る", docUndoneDiff <= 6, `diff=${docUndoneDiff}`);

    /* ================================================================
     * 選択範囲あり + 反映方法 (上書き / 置換 / 新規レイヤー)
     * ================================================================ */
    const page2 = await browser.newPage();
    page2.on("console", (msg) => console.log(`  [browser2] ${msg.text()}`));
    await page2.setViewport({ width: 1280, height: 800 });
    await page2.goto(`${fileUrl}?mode=standalone`);
    await page2.waitForSelector("#layer-list li");
    await sleep(300);
    const box2 = (await (await page2.$("#view")).boundingBox())!;
    const cx2 = box2.x + box2.width / 2;
    const cy2 = box2.y + box2.height / 2;
    const zoom2 = parseFloat((await page2.$eval("#ws-zoom", (el) => el.textContent ?? "100%")) || "100") / 100;
    const sx2 = (x: number): number => cx2 + (x - 320) * zoom2;
    const sy2 = (y: number): number => cy2 + (y - 320) * zoom2;
    const px2 = (docX: number, docY: number) => readPixel(page2, (docX - 320) * zoom2, (docY - 320) * zoom2);

    // カーソルを canvas 外へ退避させてから baseline を取る
    await page2.mouse.move(box2.x - 40, box2.y - 40);
    await sleep(150);
    const baseGap = await px2(320, 600); // ワープで画像が無くなる部分 (元画像が残るはずの点)
    const baseWarp = await px2(320, 400); // 変形画像が流れ込む部分

    /* --- 上書き (既定): 既存の画像を壊さずに変形結果を上書き --- */
    await startPuppetWarpWithSelection(page2, sx2, sy2);
    // ドラッグ中のプレビューを確認 (選択範囲あり): 押したまま途中で読む
    await page2.mouse.move(sx2(320), sy2(480));
    await page2.mouse.down();
    await page2.mouse.move(sx2(320), sy2(350), { steps: 10 });
    await sleep(220);
    const selDuring = await px2(320, 400);
    ok("選択範囲ありでもピンドラッグ中に変形プレビューが表示される", colorDiff(baseWarp, selDuring) > 4, `diff=${colorDiff(baseWarp, selDuring)}`);
    await page2.mouse.up();
    await sleep(250);
    ok("ツールタブに反映方法の 3 択が表示される", await page2.$eval('[data-warp-apply="overlay"]', (el) => (el as HTMLElement).offsetParent !== null));
    ok("反映方法の既定は「上書き」", await page2.$eval('[data-warp-apply="overlay"]', (el) => el.classList.contains("is-active")));
    await page2.keyboard.press("Enter"); // 確定 (上書き)
    await sleep(250);
    await page2.click('[data-tool="brush"]');
    await sleep(200);
    const ovGap = await px2(320, 600);
    const ovWarp = await px2(320, 400);
    ok("上書き確定: ワープで画像が無くなる部分に元の画像が残る", colorDiff(baseGap, ovGap) <= 3, `diff=${colorDiff(baseGap, ovGap)}`);
    ok("上書き確定: 変形結果が元の画像の上に重なって反映される", colorDiff(baseWarp, ovWarp) > 4, `diff=${colorDiff(baseWarp, ovWarp)}`);
    await undoKeys(page2);
    await sleep(250);

    /* --- 置換: 既存の画像を変形結果で置き換える --- */
    await startPuppetWarpWithSelection(page2, sx2, sy2);
    await dragPuppetPin(page2, sx2, sy2);
    await page2.click('[data-warp-apply="destructive"]');
    await sleep(200);
    await page2.keyboard.press("Enter");
    await sleep(250);
    await page2.click('[data-tool="brush"]');
    await sleep(200);
    const rpGap = await px2(320, 600);
    ok("置換確定: ワープで画像が無くなる部分は透明になり元画像が消える", colorDiff(baseGap, rpGap) > 30, `diff=${colorDiff(baseGap, rpGap)}`);
    await undoKeys(page2);
    await sleep(250);

    /* --- 新規レイヤー: 変形結果を元のレイヤーの真上へ新規レイヤーとして追加 --- */
    const beforeCount = await layerCount(page2);
    await startPuppetWarpWithSelection(page2, sx2, sy2);
    await dragPuppetPin(page2, sx2, sy2);
    await page2.click('[data-warp-apply="new-layer"]');
    await sleep(200);
    await page2.keyboard.press("Enter");
    await sleep(300);
    await page2.click('[data-tool="brush"]');
    await sleep(200);
    const afterCount = await layerCount(page2);
    ok("新規レイヤー確定でレイヤーが 1 枚追加される", afterCount === beforeCount + 1, `before=${beforeCount} after=${afterCount}`);
    const nlGap = await px2(320, 600);
    ok("新規レイヤー確定: 元のレイヤーは無変更 (空き部分に元画像が残る)", colorDiff(baseGap, nlGap) <= 3, `diff=${colorDiff(baseGap, nlGap)}`);
    const activeName = await activeLayerName(page2);
    ok("結果レイヤーがアクティブになる", activeName.includes("パペットワープ"), `name=${activeName}`);
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
