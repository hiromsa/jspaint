import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { viteSingleFile } from "vite-plugin-singlefile";

const ortDist = "./node_modules/onnxruntime-web/dist/";

// 単一HTMLへのインライン化(JSPaint.html 1枚で単体動作するビルド)
export default defineConfig({
  base: "./",
  plugins: [viteSingleFile()],
  build: {
    target: "es2022",
    outDir: "dist",
  },
  resolve: {
    alias: [
      {
        // AI推論ランタイム (onnxruntime-web) の wasm とローダー mjs を素パスで解決し、
        // ?url インライン (data URI) 経由で単一HTMLへ同梱する (package exports を迂回)
        find: /^#ort-wasm\?url$/,
        replacement: `${fileURLToPath(new URL(`${ortDist}ort-wasm-simd-threaded.wasm`, import.meta.url))}?url`,
      },
      {
        find: /^#ort-loader\?url$/,
        replacement: `${fileURLToPath(new URL(`${ortDist}ort-wasm-simd-threaded.mjs`, import.meta.url))}?url`,
      },
      {
        // ort 本体は「wasm 外部渡し」ビルド (ort.min.mjs) を使う。
        // bundle 版は内部に new URL(...) の wasm 参照を複数持ち Vite が全部 data URI 化して
        // 約3倍に膨らむため、wasmBinary で 1 コピーだけ渡す構成にする
        find: /^#ort-module$/,
        replacement: fileURLToPath(new URL(`${ortDist}ort.min.mjs`, import.meta.url)),
      },
    ],
  },
});


