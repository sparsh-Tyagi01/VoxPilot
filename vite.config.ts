/**
 * @file vite.config.ts
 * @description Vite build configuration for VoxPilot Chrome Extension.
 *
 * Uses @crxjs/vite-plugin to handle Manifest V3 specifics:
 * - Automatic SW bundling as a classic script (no ES module wrapper issues)
 * - HTML entry-point code splitting aware of extension page lifecycle
 * - Content script injection via manifest declarations
 *
 * Build outputs land in `dist/` which is the extension load path.
 */

import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

export default defineConfig({
  /**
   * Resolve path aliases matching tsconfig.json `paths`.
   * Keeps imports short and refactor-safe across the monorepo-like src layout.
   */
  resolve: {
    alias: {
      "@shared": "/src/shared",
      "@sw": "/src/sw",
      "@offscreen": "/src/offscreen",
      "@content": "/src/content",
      "@panel": "/src/panel",
      "@vault": "/src/vault",
    },
  },

  plugins: [
    /**
     * crx() reads manifest.json and:
     * 1. Rewrites entry points through Rollup
     * 2. Handles content script injection
     * 3. Copies web_accessible_resources
     * 4. Patches the output manifest for the dist/ folder
     */
    crx({ manifest }),
  ],

  build: {
    /**
     * Target Chromium 120+ which ships ES2022 natively.
     * Avoids unnecessary transpilation of modern syntax.
     */
    target: "chrome120",

    /**
     * Keep source maps in development for DevTools debugging.
     * Disabled in production (`build:prod`) to reduce package size.
     */
    sourcemap: true,

    /**
     * Rollup options for fine-grained chunking control.
     * Web Workers (STT, LLM) are bundled as separate chunks so they can be
     * loaded via `new Worker(new URL(...))` without import resolution issues.
     */
    rollupOptions: {
      input: {
        offscreen: "src/offscreen/offscreen.html",
        panel: "src/panel/panel.html",
        onboarding: "src/onboarding/onboarding.html",
        settings: "src/settings/settings.html",
      },
      output: {
        /**
         * Chunk naming: keeps hashes short and names descriptive for debugging.
         */
        chunkFileNames: "chunks/[name]-[hash:8].js",
        assetFileNames: "assets/[name]-[hash:8][extname]",
      },
    },

    /**
     * Raise the warning threshold — ONNX Runtime Web and model weights
     * will produce legitimately large chunks.
     */
    chunkSizeWarningLimit: 10_000, // 10 MB
  },

  /**
   * Dev server config (used by `vite build --watch`).
   * Extension development doesn't use the dev server directly,
   * but HMR-like rebuilds via --watch speed up iteration.
   */
  server: {
    port: 5173,
    strictPort: true,
  },

  /**
   * Worker bundling: inline workers use Vite's worker transform.
   * STT and LLM workers are referenced as `new Worker(new URL('./stt-worker.ts', import.meta.url))`.
   */
  worker: {
    format: "es",
  },
});
