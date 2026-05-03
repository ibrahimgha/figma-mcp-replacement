import path from "node:path";
import type { Download } from "playwright";
import { ensureDir } from "./utils/files";

export type ExportFormat = "PNG" | "JPG" | "SVG";

const EXTENSION_BY_FORMAT: Record<ExportFormat, string> = {
  PNG: ".png",
  JPG: ".jpg",
  SVG: ".svg",
};

export function extensionForFormat(format: ExportFormat): string {
  return EXTENSION_BY_FORMAT[format];
}

export function classifyDownloadedFilename(
  suggestedFilename: string,
  expectedFormat: ExportFormat,
): { basename: string; extension: string } {
  const parsed = path.parse(suggestedFilename);
  const extension = parsed.ext || extensionForFormat(expectedFormat);
  const basename = parsed.name || "download";
  return { basename, extension: extension.toLowerCase() };
}

export async function saveDownloadAs(download: Download, targetPath: string): Promise<string> {
  await ensureDir(path.dirname(targetPath));
  await download.saveAs(targetPath);
  return targetPath;
}
