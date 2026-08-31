import { defineConfig } from "vitest/config";

import { createSolidTransformPlugin } from "./src/tooling/solidTransformPlugin.ts";

export default defineConfig({
  plugins: [createSolidTransformPlugin()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: [".reference/**", ".references/**", "node_modules/**", "src-tauri/**"],
  },
});
