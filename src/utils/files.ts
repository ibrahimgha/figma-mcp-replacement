import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeFilename(value: string, fallback = "untitled"): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^\w .()@-]/g, "-")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .trim()
    .replace(/^[. -]+|[. -]+$/g, "");

  const safe = cleaned || fallback;
  const trimmed = safe.slice(0, 96).trim() || fallback;
  return RESERVED_WINDOWS_NAMES.test(trimmed) ? `${trimmed}-file` : trimmed;
}

export function frameFolderName(name: string, nodeId: string): string {
  return `${sanitizeFilename(name, "frame")}__${sanitizeFilename(nodeId.replace(/:/g, "-"))}`;
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function toPosixRelative(fromDir: string, filePath: string): string {
  return path.relative(fromDir, filePath).split(path.sep).join("/");
}
