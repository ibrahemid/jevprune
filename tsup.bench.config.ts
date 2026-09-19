import { defineConfig } from "tsup";

export default defineConfig({
  entry: { run: "bench/run.ts" },
  outDir: ".bench",
  format: ["esm"],
  target: "node22",
  platform: "node",
  splitting: false,
  clean: true,
  sourcemap: false,
  minify: false,
  dts: false,
  noExternal: ["@typesafe-ai/sdk"],
});
