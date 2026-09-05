import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/d1.ts", "src/sqlite-node.ts"],
  format: ["esm"],
  dts: true,
  deps: {
    neverBundle: ["@effect/sql-d1", "@effect/sql-sqlite-node", "effect"],
  },
});
