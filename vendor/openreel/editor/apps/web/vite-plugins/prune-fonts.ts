import type { Plugin } from "vite";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const CURATED = new Set([
  "Geist",
  "Inter",
  "Poppins",
  "Montserrat",
  "Roboto",
  "Open Sans",
  "Lato",
  "Outfit",
  "DM Sans",
]);

export function isCuratedFamily(family: string): boolean {
  return CURATED.has(family);
}

export function pruneFontsCss(css: string, removeFile: (woff2: string) => void): string {
  const blocks = css.split(/(?=@font-face)/g);
  const kept: string[] = [];
  for (const block of blocks) {
    const family = /font-family:\s*['"]([^'"]+)['"]/.exec(block)?.[1];
    if (!family) {
      kept.push(block);
      continue;
    }
    if (CURATED.has(family)) {
      kept.push(block);
      continue;
    }
    for (const match of block.matchAll(/url\(\.?\/?([^)'"]+\.woff2)\)/g)) {
      removeFile(match[1]);
    }
  }
  return kept.join("");
}

export function pruneFontsPlugin(isDesktop: boolean): Plugin {
  let fontsDir: string;
  return {
    name: "openreel-prune-fonts",
    apply: "build",
    configResolved(config): void {
      fontsDir = resolve(config.root, config.build.outDir, "fonts");
    },
    closeBundle(): void {
      if (!isDesktop) return;
      const cssPath = join(fontsDir, "google-fonts.css");
      if (!existsSync(cssPath)) return;
      const css = readFileSync(cssPath, "utf8");
      const pruned = pruneFontsCss(css, (woff2) => {
        const file = join(fontsDir, woff2.split("/").pop() ?? woff2);
        if (existsSync(file)) rmSync(file);
      });
      writeFileSync(cssPath, pruned);
    },
  };
}
