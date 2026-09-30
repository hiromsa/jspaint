/**
 * ai/ortRuntime.ts — onnxruntime-web の遅延ロードとランタイム WASM の解決
 *
 * 単一HTML (file:// 起動) でも動作させるため、ort 本体は「wasm 外部渡し」ビルド
 * (ort.min.mjs / #ort-module エイリアス) を使う。ランタイム本体 (ort-wasm-simd-threaded.wasm)
 * とローダー (ort-wasm-simd-threaded.mjs) は Vite の ?url インライン (data URI) 経由で
 * バンドルし、実行時に Blob URL へ変換して ort.env.wasm.wasmPaths へ渡す
 * (file:// からの相対読み込みは CORS でブロックされるため blob: 経路が必須)。
 * ort モジュール自体も初回利用時 (AIツールの初回クリック) まで読み込まず、起動時間を守る。
 */
import ortWasmUrl from "#ort-wasm?url";
import ortLoaderUrl from "#ort-loader?url";

/** ort (wasm / CPU のみの軽量ビルド) */
type OrtModule = typeof import("#ort-module");

let ortPromise: Promise<OrtModule> | null = null;

/** data URI を Blob URL へ変換する */
async function toBlobUrl(dataUri: string, type: string): Promise<string> {
  const buf = await fetch(dataUri).then((r) => r.arrayBuffer());
  return URL.createObjectURL(new Blob([buf], { type }));
}

/** ort モジュールを取得する (初回呼び出しで wasm とローダーを Blob URL で接続する) */
export function loadOrt(): Promise<OrtModule> {
  ortPromise ??= (async () => {
    const ort = await import("#ort-module");
    const [wasmUrl, loaderUrl] = await Promise.all([toBlobUrl(ortWasmUrl, "application/wasm"), toBlobUrl(ortLoaderUrl, "text/javascript")]);
    ort.env.wasm.wasmPaths = { mjs: loaderUrl, wasm: wasmUrl };
    return ort;
  })();
  return ortPromise;
}
