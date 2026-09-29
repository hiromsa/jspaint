import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// 単一HTMLへインライン化(JSPaint.html 1枚で単体動作するビルド)
export default defineConfig({
  base: "./",
  plugins: [viteSingleFile()],
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
