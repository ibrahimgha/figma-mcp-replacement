import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { AssetRecord, BrowserSessionInfo, CandidateRecord, ExporterOptions, FrameRecord } from "./types";
import { loadConfig } from "./config";
import { launchVisibleBrowser } from "./browserLauncher";
import { FigmaUi } from "./figmaUi";
import { addScreenshot, createManifest, writeManifest } from "./manifest";
import { dedupeFrames, parseReviewCommand, removeFramesByOneBasedIndexes } from "./review";
import { frameFolderName, ensureDir, sanitizeFilename, toPosixRelative } from "./utils/files";
import { parseFigmaUrl, readNodeIdFromUrl, withNodeId } from "./utils/url";
import type { ExportFormat } from "./downloads";
import { openFileInBrowser, writePromptReport, type PromptReportEntry } from "./promptReport";

export class FigmaBrowserExporter {
  private readonly options: ExporterOptions;
  private readonly cwd: string;
  private readline?: Interface;

  constructor(options: ExporterOptions, cwd = process.cwd()) {
    this.options = options;
    this.cwd = cwd;
  }

  async run(): Promise<void> {
    const config = await loadConfig(this.cwd);
    const launch = await launchVisibleBrowser({
      cwd: this.cwd,
      browser: this.options.browser,
      profileDir: this.options.profileDir,
    });
    const page = launch.context.pages()[0] ?? (await launch.context.newPage());
    const ui = new FigmaUi({
      page,
      config,
      cooldownMs: this.options.cooldownMs,
      downloadTimeoutMs: this.options.downloadTimeoutMs,
      logger: (message) => this.log(message),
    });

    this.readline = createInterface({ input, output });

    try {
      this.log(`Opening ${this.options.figmaUrl}`);
      await page.goto(this.options.figmaUrl, { waitUntil: "domcontentloaded" });
      await ui.waitForEditor();
      await this.pauseForUserReady();

      const autoFrames = dedupeFrames(await ui.discoverFrames(this.options.maxAutoFrames));
      const frames = await this.reviewFrames(autoFrames, ui);
      if (frames.length === 0) {
        this.log("No frames selected for export. Nothing to do.");
        return;
      }

      const reportEntries = await this.exportFrames(frames, ui, launch.info);
      if (reportEntries.length > 0) {
        const reportPath = await writePromptReport(path.dirname(reportEntries[0].frameDir), reportEntries);
        this.log(`Prompt HTML written to ${reportPath}`);
        openFileInBrowser(reportPath);
      }
    } finally {
      this.readline?.close();
      if (!this.options.keepBrowserOpen) {
        await launch.context.close();
      } else {
        this.log("Leaving browser open because --keep-browser-open was set.");
      }
    }
  }

  private async pauseForUserReady(): Promise<void> {
    await this.question([
      "",
      "Figma is open in the visible browser.",
      "Sign in, solve any challenge, and make sure the design file is fully loaded.",
      "Press Enter here when the file is ready.",
    ].join("\n"));
  }

  private async reviewFrames(frames: FrameRecord[], ui: FigmaUi): Promise<FrameRecord[]> {
    let reviewed = dedupeFrames(frames);

    while (true) {
      this.printFrames(reviewed);
      const raw = await this.question(
        "Frame review: Enter exports, 'a' adds current Figma selection, 'r 1,2' removes, 'q' cancels: ",
      );
      const command = parseReviewCommand(raw);

      if (command.action === "accept") return reviewed;
      if (command.action === "cancel") return [];
      if (command.action === "remove") {
        reviewed = removeFramesByOneBasedIndexes(reviewed, command.indexes);
        continue;
      }
      if (command.action === "add") {
        const manual = await this.readCurrentSelectionAsFrame(ui);
        if (manual) reviewed = dedupeFrames([...reviewed, manual]);
        continue;
      }

      this.log(`Unknown frame review command: ${command.raw}`);
    }
  }

  private async readCurrentSelectionAsFrame(ui: FigmaUi): Promise<FrameRecord | undefined> {
    await this.question("Select the frame in Figma, then press Enter here to record it: ");
    const nodeId = readNodeIdFromUrl(ui.currentUrl());
    if (!nodeId) {
      this.log("The current Figma URL has no node-id. Select a concrete frame and try again.");
      return undefined;
    }
    const name = (await ui.readSelectedLayerName()) ?? `Frame ${nodeId}`;
    return {
      nodeId,
      name,
      source: "manual",
      url: withNodeId(this.options.figmaUrl, nodeId),
    };
  }

  private async exportFrames(
    frames: FrameRecord[],
    ui: FigmaUi,
    browserInfo: BrowserSessionInfo,
  ): Promise<PromptReportEntry[]> {
    const parsed = parseFigmaUrl(this.options.figmaUrl);
    const fileSlug = sanitizeFilename(parsed.fileSlug, "figma-file");
    const fileDir = path.resolve(this.cwd, this.options.outDir, fileSlug);
    await ensureDir(fileDir);
    const reportEntries: PromptReportEntry[] = [];

    for (const [index, frame] of frames.entries()) {
      this.log(`Exporting frame ${index + 1}/${frames.length}: ${frame.name} (${frame.nodeId})`);
      const frameDir = path.join(fileDir, frameFolderName(frame.name, frame.nodeId));
      const assetsDir = path.join(frameDir, "assets");
      await ensureDir(assetsDir);
      const manifest = createManifest({
        sourceUrl: this.options.figmaUrl,
        runStartedAt: new Date().toISOString(),
        browser: browserInfo,
        frame,
      });

      try {
        await ui.selectNode(this.options.figmaUrl, frame.nodeId);
        const screenshot = await ui.exportSelectedAs(
          "PNG",
          path.join(frameDir, "screenshot.png"),
        );
        addScreenshot(manifest, frameDir, screenshot);
      } catch (error) {
        manifest.errors.push(`Frame screenshot export failed: ${formatError(error)}`);
      }

      if (this.options.assetMode !== "none") {
        await this.exportFrameAssets(frame, ui, assetsDir, frameDir, manifest.assets, manifest.errors);
      }

      await writeManifest(frameDir, manifest);
      reportEntries.push({ frameDir, manifest });
    }

    return reportEntries;
  }

  private async exportFrameAssets(
    frame: FrameRecord,
    ui: FigmaUi,
    assetsDir: string,
    frameDir: string,
    assets: AssetRecord[],
    errors: string[],
  ): Promise<void> {
    if (this.options.assetMode === "manual") {
      await this.exportManualAssets(frame, ui, assetsDir, frameDir, assets, errors);
      return;
    }

    let candidates: CandidateRecord[] = [];
    try {
      await ui.selectNode(this.options.figmaUrl, frame.nodeId);
      candidates = await ui.discoverAssetCandidates(this.options.maxAssetsPerFrame);
    } catch (error) {
      errors.push(`Asset discovery failed: ${formatError(error)}`);
      return;
    }

    for (const candidate of candidates) {
      const selected = await ui.clickCandidateAndReadSelection(candidate);
      if (!selected?.nodeId || !candidate.kind) {
        assets.push({
          nodeId: selected?.nodeId ?? "",
          name: candidate.name,
          kind: candidate.kind ?? "rendered-image",
          status: "skipped",
          reason: "Could not select candidate or infer export kind from the visible UI.",
        });
        continue;
      }
      await this.exportSelectedAsset(ui, assetsDir, frameDir, assets, {
        nodeId: selected.nodeId,
        name: selected.name || candidate.name,
        kind: candidate.kind,
      });
    }
  }

  private async exportManualAssets(
    frame: FrameRecord,
    ui: FigmaUi,
    assetsDir: string,
    frameDir: string,
    assets: AssetRecord[],
    errors: string[],
  ): Promise<void> {
    this.log(`Manual asset mode for ${frame.name}.`);
    while (true) {
      const raw = await this.question(
        "Select an asset in Figma, then enter 'png', 'svg', or Enter to finish this frame: ",
      );
      const value = raw.trim().toLowerCase();
      if (!value) return;
      if (value !== "png" && value !== "svg") {
        this.log("Use 'png', 'svg', or Enter.");
        continue;
      }
      const nodeId = readNodeIdFromUrl(ui.currentUrl());
      if (!nodeId) {
        errors.push("Manual asset selected without a node-id in the URL.");
        continue;
      }
      await this.exportSelectedAsset(ui, assetsDir, frameDir, assets, {
        nodeId,
        name: (await ui.readSelectedLayerName()) ?? `Asset ${nodeId}`,
        kind: value === "svg" ? "svg" : "rendered-image",
      });
    }
  }

  private async exportSelectedAsset(
    ui: FigmaUi,
    assetsDir: string,
    frameDir: string,
    assets: AssetRecord[],
    candidate: { nodeId: string; name: string; kind: "rendered-image" | "svg" },
  ): Promise<void> {
    const format: ExportFormat = candidate.kind === "svg" ? "SVG" : "PNG";
    const target = path.join(
      assetsDir,
      `${sanitizeFilename(candidate.name, "asset")}__${sanitizeFilename(candidate.nodeId.replace(/:/g, "-"))}${format === "SVG" ? ".svg" : ".png"}`,
    );
    const record: AssetRecord = {
      nodeId: candidate.nodeId,
      name: candidate.name,
      kind: candidate.kind,
      status: "failed",
    };

    try {
      const exported = await ui.exportSelectedAs(format, target);
      record.status = "exported";
      record.file = exported;
    } catch (error) {
      record.reason = formatError(error);
    }

    assets.push(record.file ? { ...record, file: toPosixRelative(frameDir, record.file) } : record);
  }

  private printFrames(frames: FrameRecord[]): void {
    this.log("");
    this.log("Frames queued for export:");
    if (frames.length === 0) {
      this.log("  (none yet)");
      return;
    }
    for (const [index, frame] of frames.entries()) {
      this.log(`  ${index + 1}. ${frame.name} [${frame.nodeId}] (${frame.source})`);
    }
  }

  private async question(prompt: string): Promise<string> {
    if (!this.readline) throw new Error("Readline is not initialized.");
    return this.readline.question(prompt);
  }

  private log(message: string): void {
    console.log(message);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
