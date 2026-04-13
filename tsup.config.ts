import { defineConfig } from "tsup";

export default defineConfig([
  {
    clean: true,
    dts: true,
    entry: {
      index: "src/index.ts",
    },
    format: ["esm"],
    outDir: "dist",
    platform: "node",
    sourcemap: true,
    target: "node22",
  },
  {
    banner: {
      js: "#!/usr/bin/env node",
    },
    clean: false,
    dts: false,
    entry: {
      cli: "src/cli/index.ts",
    },
    format: ["esm"],
    outDir: "dist",
    platform: "node",
    sourcemap: true,
    target: "node22",
  },
]);
