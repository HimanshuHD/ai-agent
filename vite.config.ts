import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
export default defineConfig({
  root: "web", base: process.env.VITE_BASE_PATH || "/", plugins: [vue()],
  build: { outDir: "../web-dist", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy: { "/api": { target: "http://127.0.0.1:3000", changeOrigin: true } } },
});
