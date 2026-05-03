import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { FigmaBrowserExporter } from "./exporter";
import type { AssetMode, BrowserChoice, ExporterOptions, ScreenshotMode } from "./types";
import { DEFAULT_CONFIG } from "./config";

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Expected a positive integer.");
  }
  return parsed;
}

function parseBrowser(value: string): BrowserChoice {
  if (value === "chrome" || value === "edge" || value === "chromium") return value;
  throw new InvalidArgumentError("Browser must be chrome, edge, or chromium.");
}

function parseAssetMode(value: string): AssetMode {
  if (value === "auto" || value === "manual" || value === "none") return value;
  throw new InvalidArgumentError("Asset mode must be auto, manual, or none.");
}

function parseScreenshotMode(value: string): ScreenshotMode {
  if (value === "auto" || value === "native" || value === "canvas") return value;
  throw new InvalidArgumentError("Screenshot mode must be auto, native, or canvas.");
}

const program = new Command();

program
  .name("figma-browser-exporter")
  .description("Export Figma frames and rendered assets through a visible, human-assisted browser.")
  .argument("<figma-url>", "Figma design URL to open")
  .option("--out <dir>", "Output directory", ".\\exports")
  .option("--browser <browser>", "Visible browser to launch: chrome, edge, or chromium", parseBrowser, "chrome")
  .option("--cooldown-ms <ms>", "Delay between UI actions", parsePositiveInt, DEFAULT_CONFIG.cooldownMs)
  .option(
    "--download-timeout-ms <ms>",
    "How long to wait for each Figma download",
    parsePositiveInt,
    DEFAULT_CONFIG.downloadTimeoutMs,
  )
  .option("--export-scale <scale>", "Export scale label, reserved for future UI tuning", DEFAULT_CONFIG.exportScale)
  .option("--profile-dir <dir>", "Persistent browser profile directory")
  .option("--asset-mode <mode>", "Asset export mode: auto, manual, or none", parseAssetMode, "auto")
  .option(
    "--screenshot-mode <mode>",
    "Screenshot mode: auto, native, or canvas",
    parseScreenshotMode,
    "auto",
  )
  .option("--max-auto-frames <count>", "Maximum auto-detected frame candidates to inspect", parsePositiveInt, 250)
  .option("--max-assets-per-frame <count>", "Maximum auto-detected asset candidates per frame", parsePositiveInt, 75)
  .option("--keep-browser-open", "Leave the browser open after the run", false)
  .option("--skip-ready-prompt", "Do not wait for terminal confirmation after opening Figma", false)
  .option("--use-url-node", "Use the node-id from the input URL as the frame to export", false)
  .option("--skip-frame-review", "Export discovered/provided frames without terminal review", false)
  .option("--frame-name <name>", "Name to use when --use-url-node cannot read a selected layer name")
  .action(async (figmaUrl: string, rawOptions) => {
    const options: ExporterOptions = {
      figmaUrl,
      outDir: path.resolve(process.cwd(), rawOptions.out),
      browser: rawOptions.browser,
      cooldownMs: rawOptions.cooldownMs,
      downloadTimeoutMs: rawOptions.downloadTimeoutMs,
      exportScale: rawOptions.exportScale,
      profileDir: rawOptions.profileDir ? path.resolve(process.cwd(), rawOptions.profileDir) : undefined,
      assetMode: rawOptions.assetMode,
      screenshotMode: rawOptions.screenshotMode,
      maxAutoFrames: rawOptions.maxAutoFrames,
      maxAssetsPerFrame: rawOptions.maxAssetsPerFrame,
      keepBrowserOpen: rawOptions.keepBrowserOpen,
      skipReadyPrompt: rawOptions.skipReadyPrompt,
      useUrlNode: rawOptions.useUrlNode,
      skipFrameReview: rawOptions.skipFrameReview,
      frameName: rawOptions.frameName,
    };

    const exporter = new FigmaBrowserExporter(options);
    await exporter.run();
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
