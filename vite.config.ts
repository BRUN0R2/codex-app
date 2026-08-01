import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/.reference/**", "**/src-tauri/**"],
    },
  },
  build: {
    target: "es2024",
    sourcemap: false,
  },
});
