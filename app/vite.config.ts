import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rsPath = resolve(
  __dirname,
  "node_modules/readable-stream/readable-browser.js"
);

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      protocolImports: true,
      include: ["buffer", "crypto", "stream", "util", "events"],
      globals: { Buffer: true, process: true, global: true },
    }),
  ],
  define: { global: "globalThis" },
  resolve: {
    alias: [
      { find: "@", replacement: resolve(__dirname, "src") },
      // Pin every `readable-stream` import to v3's browser build — v2 (shipped
      // inside hash-base) crashes during module eval in the browser.
      { find: /^readable-stream$/, replacement: rsPath },
      { find: /^readable-stream\/(.*)$/, replacement: rsPath },
    ],
  },
  optimizeDeps: {
    esbuildOptions: { target: "es2020" },
  },
  build: { target: "es2020" },
});
