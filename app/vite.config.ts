import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src",
  plugins: [react()],
  base: "./",
  build: { outDir: "../dist", emptyOutDir: true, target: "es2021" },
  // The release notes in ../docs/releases are bundled for the changelog page.
  server: { port: 3031, strictPort: true, fs: { allow: [".."] } },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
});
