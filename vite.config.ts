import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const resolvedPort = Number(
  // biome-ignore lint/complexity/useLiteralKeys: process.env requires bracket access under noPropertyAccessFromIndexSignature.
  process.env["CODEX_DESKTOP_DEV_PORT"] ?? process.env["VITE_PORT"] ?? 1420,
);
const devPort =
  Number.isFinite(resolvedPort) &&
  Number.isInteger(resolvedPort) &&
  resolvedPort > 0 &&
  resolvedPort <= 65535
    ? resolvedPort
    : 1420;

export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: devPort,
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
