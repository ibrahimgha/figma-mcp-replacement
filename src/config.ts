import path from "node:path";
import { readFile } from "node:fs/promises";
import { ensureDir, writeJson } from "./utils/files";

export interface ExporterConfig {
  cooldownMs: number;
  downloadTimeoutMs: number;
  exportScale: string;
  selectors: Record<string, string[]>;
}

export const DEFAULT_CONFIG: ExporterConfig = {
  cooldownMs: 1500,
  downloadTimeoutMs: 60000,
  exportScale: "1x",
  selectors: {
    editorReady: [
      '[role="application"]',
      "canvas",
      '[data-testid*="canvas" i]',
      '[aria-label*="figma" i]',
    ],
    layerRows: [
      '[role="treeitem"]',
      '[data-testid*="layer" i]',
      '[aria-label*="layer" i]',
      '[class*="layer" i]',
    ],
    selectedLayerRows: [
      '[aria-selected="true"]',
      '[data-selected="true"]',
      '[class*="selected" i]',
    ],
    exportButtons: [
      'button[aria-label*="export" i]',
      '[role="button"][aria-label*="export" i]',
      '[data-tooltip*="export" i]',
      'button:has-text("Export")',
      '[role="button"]:has-text("Export")',
    ],
    addExportButtons: [
      'button[aria-label*="add export" i]',
      '[role="button"][aria-label*="add export" i]',
      '[data-tooltip*="add export" i]',
      '[aria-label*="Add export setting" i]',
    ],
  },
};

export function configPath(cwd = process.cwd()): string {
  return path.join(cwd, ".figma-browser-export", "config.json");
}

export async function loadConfig(cwd = process.cwd()): Promise<ExporterConfig> {
  const filePath = configPath(cwd);
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ExporterConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      selectors: {
        ...DEFAULT_CONFIG.selectors,
        ...(parsed.selectors ?? {}),
      },
    };
  } catch (error) {
    await ensureDir(path.dirname(filePath));
    await writeJson(filePath, DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
}
