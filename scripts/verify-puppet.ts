/**
 * scripts/verify-puppet.ts — パペットワープ pure ロジック (Delaunay / メッシュ生成 / MLS 変形) の単体検証
 * 実行: npm run test:puppet
 * canvas 非依存のため、esbuild でバンドルして node 上で直接実行する。
 */
import { triangulate } from "../src/puppet/delaunay";
import { buildMesh, inverseDeformPoint, regionBounds } from "../src/puppet/mesh";
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
  const b = regionBounds(contains);
  check("regionBounds: 外接矩形", !!b && b.x0 === 100 && b.y0 === 80 && b.x1 === 199 && b.y1 === 179);
  const mesh = buildMesh(contains, 32);
  check("buildMesh: メッシュ生成 (頂点4+/三角形2+)", !!mesh && mesh.vertices.length >= 4 && mesh.triangles.length >= 2);
  check("buildMesh: 初期ピンは空", !!mesh && mesh.pins.length === 0);
  const inBox = !!mesh && mesh.vertices.every((v) => v.x >= 30 && v.x <= 270 && v.y >= 10 && v.y <= 250);
  check("buildMesh: 頂点は領域近傍 (±~70px) に収まる", inBox);
  const uniq = !!mesh && new Set(mesh.vertices.map((v) => `${v.x},${v.y}`)).size === mesh.vertices.length;
  check("buildMesh: 頂点に重複がない", uniq);
}

/* --- 5. メッシュ生成: 空領域 --- */
{
  check("buildMesh: 空領域 → null", buildMesh(() => false, 32) === null);
  check("regionBounds: 空領域 → null", regionBounds(() => false) === null);
}

/* --- 6. MLS: ピン 0 個は恒等変形 --- */
{
  const mesh = buildMesh((x, y) => x >= 100 && x < 200 && y >= 80 && y < 180, 64);
  if (!mesh) throw new Error("buildMesh failed");
  const out = computeDeformedVertices(mesh);
  const identity = out.every((v, i) => near(v.x, mesh.vertices[i].x, 1e-9) && near(v.y, mesh.vertices[i].y, 1e-9));
  check("MLS: ピン0個 → 恒等変形", identity);
}

/* --- 7. MLS: 1 ピンの平行移動 --- */
{
  const mesh = buildMesh((x, y) => x >= 100 && x < 200 && y >= 80 && y < 180, 64);
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
  const mesh = buildMesh(contains, 32);
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
