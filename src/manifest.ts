import path from "node:path";
import type { AssetRecord, BrowserSessionInfo, FrameRecord, Manifest } from "./types";
import { toPosixRelative, writeJson } from "./utils/files";

export function createManifest(args: {
  sourceUrl: string;
  runStartedAt: string;
  browser: BrowserSessionInfo;
  frame: FrameRecord;
}): Manifest {
  return {
    sourceUrl: args.sourceUrl,
    runStartedAt: args.runStartedAt,
    browser: args.browser,
    frame: args.frame,
    assets: [],
    errors: [],
  };
}

export function addScreenshot(manifest: Manifest, frameDir: string, screenshotPath: string): void {
  manifest.screenshot = toPosixRelative(frameDir, screenshotPath);
}

export function addAsset(
  manifest: Manifest,
  frameDir: string,
  asset: AssetRecord,
): AssetRecord {
  const normalized = asset.file
    ? { ...asset, file: toPosixRelative(frameDir, asset.file) }
    : asset;
  manifest.assets.push(normalized);
  return normalized;
}

export async function writeManifest(frameDir: string, manifest: Manifest): Promise<void> {
  manifest.runFinishedAt = new Date().toISOString();
  await writeJson(path.join(frameDir, "manifest.json"), manifest);
}
