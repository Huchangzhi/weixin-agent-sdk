import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./index.ts", "./main.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
});
