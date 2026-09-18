import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  splitting: false,
  clean: true,
  sourcemap: false,
  minify: false,
  dts: { entry: { index: "src/index.ts" } },
  noExternal: ["@typesafe-ai/sdk"],
});
