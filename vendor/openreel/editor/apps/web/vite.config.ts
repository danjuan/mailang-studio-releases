import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { writeFileSync } from "node:fs";
import { pruneFontsPlugin } from "./vite-plugins/prune-fonts";
import { piEditorCopyPlugin } from "./vite-plugins/pi-editor-copy";
import { assertShortDramaBundle } from "../../../assert-short-drama-bundle.mjs";

function piPluginHtml() {
  return {
    name: "openreel-pi-plugin-html",
    transformIndexHtml: {
      order: "post" as const,
      handler: (html: string) => html.replace(/type="module" crossorigin/g, "defer"),
    },
  };
}

function piPluginBundleGuard() {
  return {
    name: "openreel-pi-bundle-guard",
    generateBundle(_options, bundle) {
      const renderedModules = Object.values(bundle).flatMap(asset => asset.type === "chunk"
        ? Object.entries(asset.modules).filter(([, details]) => details.renderedLength > 0).map(([id]) => id)
        : []);
      assertShortDramaBundle("editor", renderedModules);
      const inventory = process.env.OPENREEL_EDITOR_MODULE_INVENTORY;
      if (inventory) {
        const moduleIds = [...new Set(renderedModules)].sort().map(id => path.relative(__dirname, id));
        writeFileSync(inventory, JSON.stringify(moduleIds, null, 2) + "\n");
      }
    },
  } satisfies import("vite").Plugin;
}

export default defineConfig({
  base: "./",
  plugins: [
    piPluginBundleGuard(), piEditorCopyPlugin(true), react(),
    pruneFontsPlugin(true), piPluginHtml(),
  ],
  assetsInclude: ["**/*.wasm"],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      react: path.resolve(__dirname, "./node_modules/react"),
      "react-dom": path.resolve(__dirname, "./node_modules/react-dom"),
      "@": path.resolve(__dirname, "./src"),
      "@openreel/core": path.resolve(__dirname, "../../packages/core/src"),
      "@openreel/ui": path.resolve(__dirname, "../../packages/ui/src"),
    },
  },
  worker: { format: "es" },
  build: {
    target: "esnext",
    modulePreload: false,
    rollupOptions: {
      output: {
        format: "iife",
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
