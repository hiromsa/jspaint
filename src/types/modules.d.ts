declare module "#ort-wasm?url" {
  const src: string;
  export default src;
}

declare module "#ort-loader?url" {
  const src: string;
  export default src;
}

declare module "#ort-module" {
  export * from "onnxruntime-web/wasm";
}
