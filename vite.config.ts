import { defineConfig } from "vite";

import { resolveDevelopmentPort } from "./src/tooling/developmentPort.ts";
import { createSolidTransformPlugin } from "./src/tooling/solidTransformPlugin.ts";

// biome-ignore lint/complexity/useLiteralKeys: process.env requires bracket access under noPropertyAccessFromIndexSignature.
const configuredPort = process.env["CODEX_DESKTOP_DEV_PORT"] ?? process.env["VITE_PORT"];
const devPort = resolveDevelopmentPort(configuredPort);

export default defineConfig({
  // The application controller owns long-lived signals, native subscriptions, and
  // async coordinators. Component-level HMR can preserve that controller while
  // replacing consumers with a newer interface, producing a mixed runtime graph.
  // A full reload keeps the controller and every UI consumer on the same revision.
  plugins: [createSolidTransformPlugin({ hot: false })],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: devPort,
    strictPort: true,
    watch: {
      ignored: ["**/.reference/**", "**/.references/**", "**/src-tauri/**"],
    },
  },
  build: {
    target: "es2024",
    sourcemap: false,
  },
});
