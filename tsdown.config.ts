import { defineConfig } from "tsdown";

export default defineConfig({
  deps: {
    neverBundle: ["effect"],
  },
  dts: true,
  entry: ["src/index.ts"],
  format: ["esm"],
});
