// Builds the interface with the mock backend, for the README screenshots (readme-screenshots.sh).
import path from "node:path";
import react from "@vitejs/plugin-react";

const app = path.resolve(import.meta.dirname, "../..");
export default {
  root: import.meta.dirname,
  base: "./",
  plugins: [react()],
  css: { postcss: app },
  resolve: { alias: { "@": path.join(app, "src") } },
  build: { emptyOutDir: true, chunkSizeWarningLimit: 4096 },
  logLevel: "warn",
};
