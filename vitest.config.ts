import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "./src/shared"),
      "@sw": path.resolve(__dirname, "./src/sw"),
      "@offscreen": path.resolve(__dirname, "./src/offscreen"),
      "@content": path.resolve(__dirname, "./src/content"),
      "@panel": path.resolve(__dirname, "./src/panel"),
      "@vault": path.resolve(__dirname, "./src/vault"),
    },
  },
  test: {
    environment: "node",
    globals: true,
  },
});
