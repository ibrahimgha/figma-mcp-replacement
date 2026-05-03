import type { Page } from "playwright";
import { PNG } from "pngjs";
import path from "node:path";
import type { AssetKind, CandidateRecord, CanvasSelectionBox, FrameRecord, LeftSectionRecord } from "./types";
import type { ExporterConfig } from "./config";
import { readNodeIdFromUrl, withNodeId } from "./utils/url";
import { extensionForFormat, saveDownloadAs, type ExportFormat } from "./downloads";
import { mkdir, writeFile } from "node:fs/promises";
import {
  cropPng,
  findFigmaSelectionCrop,
  findLargestForegroundCrop,
  isLikelyFigmaLoadingScreenshot,
  isLikelyScreenCrop,
  type CropBox,
} from "./imageCrop";
import { skipReasonForFrameCandidate } from "./frameFilters";

interface FigmaUiArgs {
  page: Page;
  config: ExporterConfig;
  cooldownMs: number;
  downloadTimeoutMs: number;
  logger: (message: string) => void;
}

interface BrowserCandidate {
  candidateId: number;
  name: string;
  confidence: number;
  reason: string;
  kind?: AssetKind;
  layerKind?: string;
}

interface CanvasScreenCandidate extends CanvasSelectionBox {
  pixels: number;
}

interface MaskComponent {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  pixels: number;
}

declare global {
  interface Window {
    __figmaBrowserExporterCandidates?: HTMLElement[];
  }
}

export class FigmaUi {
  private readonly page: Page;
  private readonly config: ExporterConfig;
  private readonly cooldownMs: number;
  private readonly downloadTimeoutMs: number;
  private readonly logger: (message: string) => void;

  constructor(args: FigmaUiArgs) {
    this.page = args.page;
    this.config = args.config;
    this.cooldownMs = args.cooldownMs;
    this.downloadTimeoutMs = args.downloadTimeoutMs;
    this.logger = args.logger;
  }

  async waitForEditor(): Promise<void> {
    await this.page.waitForLoadState("domcontentloaded");
    await this.ensureBrowserEvalHelpers();
    await this.page.waitForTimeout(this.cooldownMs);
    for (const selector of this.config.selectors.editorReady) {
      const locator = this.page.locator(selector).first();
      try {
        await locator.waitFor({ state: "attached", timeout: 5000 });
        return;
      } catch {
        // Try the next readiness signal.
      }
    }
  }

  async discoverFrames(maxFrames: number): Promise<FrameRecord[]> {
    await this.ensureBrowserEvalHelpers();
    const candidates = await this.extractFrameCandidatesFromLayers(maxFrames);
    return this.framesFromLayerCandidates(candidates);
  }

  async discoverReadyDevelopmentFrames(maxFrames: number, preCaptureDir?: string): Promise<FrameRecord[]> {
    await this.ensureBrowserEvalHelpers();
    const maxAttempts = 7;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const candidates = (await this.extractFrameCandidatesFromLayers(maxFrames))
        .filter((candidate) => candidate.layerKind === "Ready for development");
      if (candidates.length > 0) {
        this.logger(`Using ${candidates.length} Ready for development row(s) from the visible Figma UI.`);
        return this.framesFromLayerCandidates(candidates, preCaptureDir);
      }
      if (attempt < maxAttempts) {
        this.logger(`Waiting for Figma's Ready for development rows ${attempt}/${maxAttempts}.`);
        await this.page.waitForTimeout(Math.max(this.cooldownMs, 2500));
      }
    }
    return [];
  }

  private async framesFromLayerCandidates(
    candidates: CandidateRecord[],
    preCaptureDir?: string,
  ): Promise<FrameRecord[]> {
    const frames: FrameRecord[] = [];
    for (const candidate of candidates) {
      const selected = await this.clickFrameCandidateAndReadSelection(candidate);
      if (!selected?.nodeId) continue;
      const frame: FrameRecord = {
        nodeId: selected.nodeId,
        name: candidate.name || selected.name,
        source: "auto",
        url: withNodeId(this.page.url(), selected.nodeId),
        layer: {
          name: candidate.name,
          kind: candidate.layerKind,
          occurrence: candidate.occurrence,
        },
      };
      if (preCaptureDir) {
        await mkdir(preCaptureDir, { recursive: true });
        const target = path.join(preCaptureDir, `${selected.nodeId.replace(/:/g, "-")}.png`);
        try {
          frame.preCapturedScreenshot = await this.captureSelectedFrameScreenshot(target);
        } catch (error) {
          this.logger(`Pre-capture failed for ${frame.name} (${selected.nodeId}): ${error instanceof Error ? error.message : String(error)}.`);
        }
      }
      frames.push(frame);
    }
    return frames;
  }

  async discoverCanvasBoardScreens(
    figmaUrl: string,
    maxFrames: number,
    preCaptureDir?: string,
  ): Promise<FrameRecord[]> {
    await this.ensureBrowserEvalHelpers();
    await this.page.waitForTimeout(Math.max(this.cooldownMs, 1600));

    const readyFrames = await this.discoverReadyDevelopmentFrames(maxFrames, preCaptureDir);
    if (readyFrames.length >= Math.min(30, maxFrames)) {
      this.logger(`Selected ${readyFrames.length} screen frame(s) from Figma's Ready for development panel.`);
      return readyFrames;
    }
    if (readyFrames.length > 0) {
      this.logger(`Ready for development panel only yielded ${readyFrames.length} frame(s); falling back to canvas-board detection.`);
    }

    await this.ensureDesignModeForCanvasDiscovery();
    await this.restoreCanvasBoardViewForDiscovery(maxFrames);

    const boardNodeId = readNodeIdFromUrl(figmaUrl);
    const boardName = (await this.readSelectedLayerName().catch(() => undefined)) ?? "Canvas board";
    const ignoredNodeIds = new Set<string>(boardNodeId ? [boardNodeId] : []);
    const candidates = await this.detectCanvasScreenCandidates(maxFrames);
    this.logger(`Detected ${candidates.length} phone-screen candidate(s) on the visible canvas board.`);

    const frames: FrameRecord[] = [];
    const seen = new Set<string>();
    const knownNodeIds = new Set<string>(readyFrames.map((frame) => frame.nodeId).filter(Boolean));
    for (let index = 0; index < candidates.length; index += 1) {
      let candidate = candidates[index];
      if (index > 0) {
        const restoredCandidates = await this.restoreCanvasBoardViewForDiscovery(maxFrames);
        candidate = restoredCandidates[index] ?? nearestCanvasCandidate(candidate, restoredCandidates) ?? candidate;
      }
      let selected = await this.clickCanvasScreenCandidateAndReadSelection(
        candidate,
        new Set([...ignoredNodeIds, ...knownNodeIds, ...seen]),
      );
      if (!selected?.nodeId) {
        selected = await this.clickCanvasScreenCandidateAndReadSelection(candidate, ignoredNodeIds);
      }
      if (!selected?.nodeId) {
        this.logger(`Canvas candidate ${index + 1}/${candidates.length} did not resolve to a concrete frame.`);
        continue;
      }
      if (knownNodeIds.has(selected.nodeId)) {
        this.logger(`Canvas candidate ${index + 1}/${candidates.length} selected already-covered Ready frame ${selected.name} (${selected.nodeId}).`);
        continue;
      }
      if (seen.has(selected.nodeId)) {
        this.logger(`Canvas candidate ${index + 1}/${candidates.length} selected duplicate frame ${selected.name} (${selected.nodeId}).`);
        continue;
      }
      const readableName = selected.name.trim();
      const skipReason = readableName ? skipReasonForFrameCandidate({ name: readableName }) : undefined;
      if (readableName && (skipReason || this.isCanvasDiscoveryNoise(readableName))) {
        this.logger(`Skipping canvas selection ${readableName} (${selected.nodeId}): ${skipReason ?? "utility/board layer"}.`);
        continue;
      }
      const frameName = readableName || `Screen ${String(index + 1).padStart(2, "0")}`;
      seen.add(selected.nodeId);
      const frame: FrameRecord = {
        nodeId: selected.nodeId,
        name: frameName,
        pageName: boardName,
        source: "auto",
        url: withNodeId(figmaUrl, selected.nodeId),
        canvas: {
          x: candidate.x,
          y: candidate.y,
          width: candidate.width,
          height: candidate.height,
          order: index,
        },
      };
      if (preCaptureDir) {
        await mkdir(preCaptureDir, { recursive: true });
        const target = path.join(preCaptureDir, `${selected.nodeId.replace(/:/g, "-")}.png`);
        try {
          frame.preCapturedScreenshot = await this.captureSelectedFrameScreenshot(target);
        } catch (error) {
          this.logger(`Pre-capture failed for ${frameName} (${selected.nodeId}): ${error instanceof Error ? error.message : String(error)}.`);
        }
      }
      frames.push(frame);
      this.logger(`Canvas screen ${frames.length}: ${frameName} (${selected.nodeId})`);
      if (frames.length >= maxFrames) break;
    }

    this.logger(`Selected ${frames.length} unique canvas screen frame(s) from the visible board.`);
    if (readyFrames.length > 0) {
      const combined = uniqueFramesByNodeId([...readyFrames, ...frames]).slice(0, maxFrames);
      this.logger(`Merged Ready panel and canvas discovery into ${combined.length} unique screen frame(s).`);
      return combined;
    }
    return frames;
  }

  async selectCanvasDiscoveredFrame(
    figmaUrl: string,
    frame: FrameRecord,
    maxFrames: number,
  ): Promise<void> {
    if (!frame.canvas) {
      await this.selectNode(figmaUrl, frame.nodeId);
      return;
    }

    const boardNodeId = readNodeIdFromUrl(figmaUrl);
    const ignoredNodeIds = new Set<string>(boardNodeId ? [boardNodeId] : []);
    const restoredCandidates = await this.restoreCanvasBoardViewForDiscovery(maxFrames);
    const preferred = restoredCandidates[frame.canvas.order ?? -1] ?? nearestCanvasCandidate(frame.canvas, restoredCandidates) ?? {
      ...frame.canvas,
      pixels: 0,
    };

    let selected = await this.clickCanvasScreenCandidateAndReadSelection(preferred, ignoredNodeIds);
    if (selected?.nodeId !== frame.nodeId && preferred !== frame.canvas) {
      selected = await this.clickCanvasScreenCandidateAndReadSelection({ ...frame.canvas, pixels: 0 }, ignoredNodeIds);
    }

    if (!selected?.nodeId) {
      throw new Error(`Could not reselect ${frame.name} from the warm canvas view.`);
    }
    if (selected.nodeId !== frame.nodeId) {
      throw new Error(
        `Warm canvas selection mismatch for ${frame.name}: expected ${frame.nodeId}, got ${selected.nodeId} (${selected.name}).`,
      );
    }
  }

  async discoverLeftSidebarSections(maxSections: number): Promise<LeftSectionRecord[]> {
    await this.ensureBrowserEvalHelpers();
    await this.ensureFigmaUiVisible();
    const sections = await this.page.evaluate(async (limit) => {
      function clean(value: string | null | undefined): string {
        return (value ?? "").replace(/\s+/g, " ").trim();
      }

      function isVisible(element: Element): boolean {
        const html = element as HTMLElement;
        return Boolean(html.offsetWidth || html.offsetHeight || html.getClientRects().length);
      }

      function isPageRow(element: HTMLElement): boolean {
        const classes = [
          String(element.className),
          String(element.parentElement?.className ?? ""),
          String(element.parentElement?.parentElement?.className ?? ""),
        ].join(" ");
        return /pageRow|pagesRow|renameableNode/i.test(classes);
      }

      function pageRows(): HTMLElement[] {
        return Array.from(document.querySelectorAll<HTMLElement>("button, div[role='button']"))
          .filter((row) => isVisible(row))
          .filter((row) => row.getBoundingClientRect().left < 300)
          .filter(isPageRow)
          .filter((row) => {
            const text = clean(row.innerText || row.textContent);
            if (!text || text.length > 120) return false;
            if (/^(Pages|Show all pages|Ready for development|Layers)$/i.test(text)) return false;
            if (/\bEdited\b/i.test(text)) return false;
            return true;
          });
      }

      function findPageScrollContainer(): HTMLElement | Window {
        const explicit = Array.from(document.querySelectorAll<HTMLElement>("[class*='pages'][class*='scroll' i], [class*='pagesList' i]"))
          .find((element) => isVisible(element) && element.getBoundingClientRect().left < 300);
        if (explicit) return explicit;

        const row = pageRows()[0];
        let current = row?.parentElement;
        while (current) {
          const style = window.getComputedStyle(current);
          if (
            current.scrollHeight > current.clientHeight + 20 &&
            !/hidden/i.test(style.overflowY) &&
            current.getBoundingClientRect().left < 300
          ) {
            return current;
          }
          current = current.parentElement;
        }
        return window;
      }

      async function settle() {
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }

      async function waitForPageRows() {
        const startedAt = Date.now();
        while (Date.now() - startedAt < 15000) {
          if (pageRows().length > 0) return true;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return false;
      }

      if (!(await waitForPageRows())) return [];

      const showAll = Array.from(document.querySelectorAll<HTMLElement>("button, [role='button']"))
        .filter((button) => isVisible(button))
        .find((button) => /^Show all pages$/i.test(clean(button.innerText || button.textContent || button.getAttribute("aria-label"))));
      if (showAll) {
        showAll.click();
        await settle();
      }

      const scroller = findPageScrollContainer();
      const scrollerElement: HTMLElement | undefined = scroller === window ? undefined : (scroller as HTMLElement);
      const original = scrollerElement ? scrollerElement.scrollTop : window.scrollY;
      const max = scrollerElement
        ? Math.max(0, scrollerElement.scrollHeight - scrollerElement.clientHeight)
        : Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const pageSize = scrollerElement ? Math.max(96, scrollerElement.clientHeight) : window.innerHeight;
      const seen = new Set<string>();
      const found: string[] = [];

      for (let top = 0; top <= max + 1 && found.length < limit; top += Math.max(48, Math.floor(pageSize * 0.75))) {
        if (scrollerElement) scrollerElement.scrollTop = top;
        else window.scrollTo(0, top);
        await settle();
        for (const row of pageRows()) {
          const name = clean(row.innerText || row.textContent);
          if (!name || seen.has(name)) continue;
          seen.add(name);
          found.push(name);
          if (found.length >= limit) break;
        }
      }

      if (scrollerElement) scrollerElement.scrollTop = original;
      else window.scrollTo(0, original);

      return found.map((name) => ({ name, source: "pages-panel" as const }));
    }, maxSections);

    this.logger(`Discovered ${sections.length} left sidebar section(s) from the Figma Pages panel.`);
    return sections;
  }

  async selectLeftSidebarSection(section: LeftSectionRecord): Promise<boolean> {
    await this.ensureBrowserEvalHelpers();
    await this.ensureFigmaUiVisible();
    const clicked = await this.page.evaluate(async (targetName) => {
      function clean(value: string | null | undefined): string {
        return (value ?? "").replace(/\s+/g, " ").trim();
      }

      function isVisible(element: Element): boolean {
        const html = element as HTMLElement;
        return Boolean(html.offsetWidth || html.offsetHeight || html.getClientRects().length);
      }

      function isPageRow(element: HTMLElement): boolean {
        const classes = [
          String(element.className),
          String(element.parentElement?.className ?? ""),
          String(element.parentElement?.parentElement?.className ?? ""),
        ].join(" ");
        return /pageRow|pagesRow|renameableNode/i.test(classes);
      }

      function pageRows(): HTMLElement[] {
        return Array.from(document.querySelectorAll<HTMLElement>("button, div[role='button']"))
          .filter((row) => isVisible(row))
          .filter((row) => row.getBoundingClientRect().left < 300)
          .filter(isPageRow);
      }

      function findPageScrollContainer(): HTMLElement | Window {
        const explicit = Array.from(document.querySelectorAll<HTMLElement>("[class*='pages'][class*='scroll' i], [class*='pagesList' i]"))
          .find((element) => isVisible(element) && element.getBoundingClientRect().left < 300);
        if (explicit) return explicit;

        const row = pageRows()[0];
        let current = row?.parentElement;
        while (current) {
          const style = window.getComputedStyle(current);
          if (
            current.scrollHeight > current.clientHeight + 20 &&
            !/hidden/i.test(style.overflowY) &&
            current.getBoundingClientRect().left < 300
          ) {
            return current;
          }
          current = current.parentElement;
        }
        return window;
      }

      async function settle() {
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }

      async function waitForPageRows() {
        const startedAt = Date.now();
        while (Date.now() - startedAt < 15000) {
          if (pageRows().length > 0) return true;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return false;
      }

      if (!(await waitForPageRows())) return false;

      const showAll = Array.from(document.querySelectorAll<HTMLElement>("button, [role='button']"))
        .filter((button) => isVisible(button))
        .find((button) => /^Show all pages$/i.test(clean(button.innerText || button.textContent || button.getAttribute("aria-label"))));
      if (showAll) {
        showAll.click();
        await settle();
      }

      const scroller = findPageScrollContainer();
      const scrollerElement: HTMLElement | undefined = scroller === window ? undefined : (scroller as HTMLElement);
      const original = scrollerElement ? scrollerElement.scrollTop : window.scrollY;
      const max = scrollerElement
        ? Math.max(0, scrollerElement.scrollHeight - scrollerElement.clientHeight)
        : Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const pageSize = scrollerElement ? Math.max(96, scrollerElement.clientHeight) : window.innerHeight;

      for (let top = 0; top <= max + 1; top += Math.max(48, Math.floor(pageSize * 0.75))) {
        if (scrollerElement) scrollerElement.scrollTop = top;
        else window.scrollTo(0, top);
        await settle();
        const match = pageRows().find((row) => clean(row.innerText || row.textContent) === targetName);
        if (!match) continue;
        match.scrollIntoView({ block: "center", inline: "nearest" });
        await settle();
        const rect = match.getBoundingClientRect();
        const x = rect.left + Math.min(rect.width / 2, 88);
        const y = rect.top + rect.height / 2;
        match.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
        match.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
        match.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
        match.click();
        return true;
      }

      if (scrollerElement) scrollerElement.scrollTop = original;
      else window.scrollTo(0, original);
      return false;
    }, section.name);

    if (clicked) {
      await this.page.waitForTimeout(Math.max(this.cooldownMs, 1800));
    }
    return clicked;
  }

  async discoverAssetCandidates(maxAssets: number): Promise<CandidateRecord[]> {
    await this.ensureBrowserEvalHelpers();
    return (await this.extractCandidates("asset")).slice(0, maxAssets);
  }

  async clickCandidateAndReadSelection(candidate: CandidateRecord): Promise<{
    nodeId?: string;
    name: string;
  } | null> {
    const clicked = await this.page.evaluate((candidateId) => {
      const candidates = window.__figmaBrowserExporterCandidates ?? [];
      const element = candidates[candidateId];
      if (!element) return false;
      element.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = element.getBoundingClientRect();
      const x = rect.left + Math.min(rect.width / 2, 24);
      const y = rect.top + rect.height / 2;
      element.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
      element.click();
      return true;
    }, candidate.candidateId);

    if (!clicked) return null;
    await this.page.waitForTimeout(this.cooldownMs);
    return {
      nodeId: readNodeIdFromUrl(this.page.url()),
      name: (await this.readSelectedLayerName()) ?? candidate.name,
    };
  }

  async clickFrameCandidateAndReadSelection(candidate: CandidateRecord): Promise<{
    nodeId?: string;
    name: string;
  } | null> {
    const clicked = await this.clickLayerRowByName(candidate.name, candidate.layerKind, candidate.occurrence);
    if (!clicked) return this.clickCandidateAndReadSelection(candidate);
    await this.page.waitForTimeout(this.cooldownMs);
    return {
      nodeId: readNodeIdFromUrl(this.page.url()),
      name: candidate.name,
    };
  }

  async selectFrameFromLayerRow(frame: FrameRecord): Promise<boolean> {
    if (!frame.layer) return false;
    const clicked = await this.clickLayerRowByName(
      frame.layer.name,
      frame.layer.kind,
      frame.layer.occurrence,
    );
    if (!clicked) return false;
    await this.page.waitForTimeout(this.cooldownMs);
    const selectedNodeId = readNodeIdFromUrl(this.page.url());
    return selectedNodeId === frame.nodeId;
  }

  async selectNode(figmaUrl: string, nodeId: string, expectedName?: string): Promise<void> {
    const targetUrl = withNodeId(figmaUrl, nodeId);
    let lastName: string | undefined;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await this.page.goto(targetUrl, { waitUntil: "domcontentloaded" });
      await this.page.waitForTimeout(Math.max(this.cooldownMs, 2500));

      const selectedNodeId = readNodeIdFromUrl(this.page.url());
      lastName = await this.readCanvasSelectedLayerName().catch(() => undefined);
      if (selectedNodeId === nodeId && (!expectedName || !lastName || selectedLayerNameMatches(lastName, expectedName))) {
        return;
      }

      if (attempt < 4) {
        this.logger(
          `Figma has not selected ${expectedName ?? nodeId} yet after URL navigation (${lastName ?? "unknown"} selected); retrying ${attempt}/4.`,
        );
        if (attempt === 2) {
          await this.page.goto("about:blank", { waitUntil: "domcontentloaded" }).catch(() => undefined);
        }
        await this.page.waitForTimeout(Math.max(this.cooldownMs, 1200));
      }
    }

    throw new Error(
      `Figma did not select requested node ${nodeId}${expectedName ? ` (${expectedName})` : ""}; last selected layer was ${lastName ?? "unknown"}.`,
    );
  }

  async readSelectedLayerName(): Promise<string | undefined> {
    await this.ensureBrowserEvalHelpers();
    return this.page.evaluate((selectors) => {
      for (const selector of selectors) {
        const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
        for (const element of elements) {
          const text = (element.innerText || element.textContent || element.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .trim();
          if (text && text.length <= 160) return text;
        }
      }
      return undefined;
    }, this.config.selectors.selectedLayerRows);
  }

  currentUrl(): string {
    return this.page.url();
  }

  async exportSelectedAs(format: ExportFormat, targetPath: string): Promise<string> {
    await this.prepareExportSetting(format);
    const exportButton = await this.findVisibleExportButton();
    if (!exportButton) {
      throw new Error("Could not find a visible Figma Export button for the selected node.");
    }

    const [download] = await Promise.all([
      this.page.waitForEvent("download", { timeout: this.downloadTimeoutMs }),
      exportButton.click({ timeout: 10000 }),
    ]);

    const finalPath = targetPath.endsWith(extensionForFormat(format))
      ? targetPath
      : `${targetPath}${extensionForFormat(format)}`;
    await saveDownloadAs(download, finalPath);
    return finalPath;
  }

  async captureViewportScreenshot(targetPath: string): Promise<string> {
    await this.page.screenshot({
      path: targetPath,
      fullPage: false,
    });
    return targetPath;
  }

  async captureSelectedFrameScreenshot(targetPath: string): Promise<string> {
    const didHideUi = await this.hideFigmaUiForCapture();
    try {
      const maxAttempts = 8;
      let lastError: Error | undefined;

      await this.zoomToSelection();
      await this.clearSelectionForCleanCapture();

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        await this.moveMouseAwayFromCanvasTargets();
        const canvasBox = await this.visibleCanvasSearchBox();
        const screenshot = await this.page.screenshot({ fullPage: false });

        if (isLikelyFigmaLoadingScreenshot(screenshot)) {
          this.logger(`Figma is still rendering the selected frame; waiting before screenshot retry ${attempt}/${maxAttempts}.`);
          await this.page.waitForTimeout(Math.max(this.cooldownMs, 2500));
          continue;
        }

        const crop =
          findLargestForegroundCrop(screenshot, canvasBox) ??
          findFigmaSelectionCrop(screenshot, canvasBox);
        if (!crop) {
          lastError = new Error("Could not detect the selected frame in the Figma viewport.");
          this.logger(`Could not detect the selected frame crop; waiting before screenshot retry ${attempt}/${maxAttempts}.`);
          await this.page.waitForTimeout(Math.max(this.cooldownMs, 1800));
          continue;
        }
        if (!isLikelyScreenCrop(crop)) {
          lastError = new Error(
            `Detected crop is not screen-like: x=${crop.x}, y=${crop.y}, width=${crop.width}, height=${crop.height}.`,
          );
          this.logger(
            `Detected crop is not screen-like; waiting before screenshot retry ${attempt}/${maxAttempts}.`,
          );
          await this.page.waitForTimeout(Math.max(this.cooldownMs, 1800));
          continue;
        }

        const cropped = cropPng(screenshot, crop);
        if (isLikelyFigmaLoadingScreenshot(cropped)) {
          this.logger(`Cropped screenshot still looks like Figma loading UI; waiting before retry ${attempt}/${maxAttempts}.`);
          await this.page.waitForTimeout(Math.max(this.cooldownMs, 2500));
          continue;
        }

        await writeFile(targetPath, cropped);
        return targetPath;
      }

      throw lastError ?? new Error("Figma canvas did not finish rendering the selected frame before screenshot retries expired.");
    } finally {
      if (didHideUi) await this.showFigmaUiAfterCapture();
    }
  }

  private async restoreCanvasBoardViewForDiscovery(maxFrames: number): Promise<CanvasScreenCandidate[]> {
    await this.page.keyboard.press("Shift+1").catch(() => undefined);
    const maxAttempts = 5;
    let lastCandidates: CanvasScreenCandidate[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await this.page.waitForTimeout(Math.max(this.cooldownMs, 1800));
      const screenshot = await this.page.screenshot({ fullPage: false });
      const { candidates } = findCanvasScreenCandidatesInScreenshot(screenshot, maxFrames);
      lastCandidates = candidates;
      if (candidates.length > 0) return candidates;
      if (attempt < maxAttempts) {
        await this.page.keyboard.press("Shift+1").catch(() => undefined);
        this.logger(`Waiting for canvas board overview to repaint before next candidate ${attempt}/${maxAttempts}.`);
      }
    }
    return lastCandidates;
  }

  private async ensureDesignModeForCanvasDiscovery(): Promise<void> {
    await this.ensureBrowserEvalHelpers();
    const inDevMode = await this.page.evaluate(() => {
      const url = new URL(window.location.href);
      if (url.searchParams.get("m") === "dev") return true;
      const visibleText = Array.from(document.querySelectorAll<HTMLElement>("button,[role='button'],[aria-label]"))
        .filter((element) => Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length))
        .map((element) =>
          [
            element.getAttribute("aria-label"),
            element.getAttribute("data-tooltip"),
            element.innerText,
            element.textContent,
          ]
            .filter(Boolean)
            .join(" "),
        )
        .join(" ");
      return /\bInspect\b/.test(visibleText) && /\bMCP\b/.test(visibleText);
    });
    if (!inDevMode) return;

    const clicked = await this.page.evaluate(() => {
      function clean(value: string | null | undefined): string {
        return (value ?? "").replace(/\s+/g, " ").trim();
      }

      const controls = Array.from(document.querySelectorAll<HTMLElement>("button,[role='button']"))
        .filter((element) => Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length));
      const devMode = controls.find((element) => {
        const text = [
          element.getAttribute("aria-label"),
          element.getAttribute("data-tooltip"),
          element.innerText,
          element.textContent,
        ]
          .map(clean)
          .filter(Boolean)
          .join(" ");
        return /\bDev Mode\b/i.test(text);
      });
      if (!devMode) return false;
      devMode.click();
      return true;
    });

    if (clicked) {
      this.logger("Switched Figma out of Dev Mode for canvas-board discovery.");
      await this.page.waitForTimeout(Math.max(this.cooldownMs, 1800));
    }
  }

  private async detectCanvasScreenCandidates(maxFrames: number): Promise<CanvasScreenCandidate[]> {
    const maxAttempts = 8;
    let lastBoardBox: CropBox | undefined;
    let lastCandidates: CanvasScreenCandidate[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const screenshot = await this.page.screenshot({ fullPage: false });
      const result = findCanvasScreenCandidatesInScreenshot(screenshot, maxFrames);
      lastBoardBox = result.boardBox;
      lastCandidates = result.candidates;
      this.logger(
        `Canvas board search area: x=${result.boardBox.x}, y=${result.boardBox.y}, width=${result.boardBox.width}, height=${result.boardBox.height}.`,
      );
      if (result.candidates.length > 0) return result.candidates;
      if (attempt < maxAttempts) {
        this.logger(`Canvas board is visible but screen thumbnails are not detected yet; waiting before retry ${attempt}/${maxAttempts}.`);
        await this.page.waitForTimeout(Math.max(this.cooldownMs, 2500));
      }
    }

    if (lastBoardBox) {
      this.logger(
        `Canvas screen detection ended with 0 candidates in x=${lastBoardBox.x}, y=${lastBoardBox.y}, width=${lastBoardBox.width}, height=${lastBoardBox.height}.`,
      );
    }
    return lastCandidates;
  }

  private async clickCanvasScreenCandidateAndReadSelection(
    candidate: CanvasScreenCandidate,
    ignoredNodeIds: Set<string>,
  ): Promise<{ nodeId?: string; name: string } | null> {
    const offsets = [
      { x: 0.5, y: 0.5 },
      { x: 0.5, y: 0.42 },
      { x: 0.5, y: 0.32 },
      { x: 0.35, y: 0.5 },
      { x: 0.65, y: 0.5 },
      { x: 0.5, y: 0.72 },
      { x: 0.12, y: 0.12 },
      { x: 0.88, y: 0.12 },
      { x: 0.12, y: 0.88 },
      { x: 0.88, y: 0.88 },
    ];
    const waitMs = Math.max(700, Math.min(this.cooldownMs, 1400));

    for (const offset of offsets) {
      const x = Math.round(candidate.x + candidate.width * offset.x);
      const y = Math.round(candidate.y + candidate.height * offset.y);
      await this.page.mouse.click(x, y);
      await this.page.waitForTimeout(waitMs);

      const nodeId = readNodeIdFromUrl(this.page.url());
      const name = (await this.readCanvasSelectedLayerName()) ?? "";
      if (!nodeId || ignoredNodeIds.has(nodeId)) continue;
      if (name && this.isCanvasDiscoveryNoise(name)) continue;

      if (this.shouldClimbCanvasSelection(name)) {
        const parent = await this.selectCanvasParentFrame(ignoredNodeIds);
        if (parent?.nodeId && parent.name && !this.isCanvasDiscoveryNoise(parent.name)) {
          return parent;
        }
        continue;
      }

      if (this.shouldRejectCanvasSelection(name)) continue;
      return { nodeId, name };
    }

    return null;
  }

  private async selectCanvasParentFrame(
    ignoredNodeIds: Set<string>,
  ): Promise<{ nodeId?: string; name: string } | null> {
    await this.page.keyboard.press("Shift+Enter").catch(() => undefined);
    await this.page.waitForTimeout(Math.max(700, Math.min(this.cooldownMs, 1200)));
    const nodeId = readNodeIdFromUrl(this.page.url());
    const name = (await this.readCanvasSelectedLayerName()) ?? "";
    if (!nodeId || ignoredNodeIds.has(nodeId) || !name) return null;
    if (
      this.isCanvasDiscoveryNoise(name) ||
      this.shouldRejectCanvasSelection(name) ||
      this.shouldClimbCanvasSelection(name)
    ) {
      return null;
    }
    return { nodeId, name };
  }

  private async readCanvasSelectedLayerName(): Promise<string | undefined> {
    await this.ensureBrowserEvalHelpers();
    const rightPanelName = await this.page.evaluate(() => {
      function clean(value: string | null | undefined): string {
        return (value ?? "").replace(/\s+/g, " ").trim();
      }

      function isVisible(element: Element): boolean {
        const html = element as HTMLElement;
        return Boolean(html.offsetWidth || html.offsetHeight || html.getClientRects().length);
      }

      const selectors = [
        '[data-tooltip*="copy layer name" i]',
        '[aria-label*="copy layer name" i]',
        '[title*="copy layer name" i]',
      ];
      for (const selector of selectors) {
        const elements = Array.from(document.querySelectorAll<HTMLElement>(selector))
          .filter(isVisible)
          .filter((element) => element.getBoundingClientRect().left > window.innerWidth * 0.55);
        for (const element of elements) {
          const copyName = [
            element.getAttribute("aria-label"),
            element.getAttribute("data-tooltip"),
            element.getAttribute("title"),
          ]
            .map((value) => clean(value))
            .map((value) => value.match(/^click to copy layer name:\s*(.+)$/i)?.[1]?.trim())
            .find((value) => value && value.length <= 160);
          if (copyName) return copyName;
          const text = clean(element.innerText || element.textContent);
          if (text && !/^click to copy layer name$/i.test(text) && text.length <= 160) return text;
          const aria = clean(element.getAttribute("aria-label") || element.getAttribute("title"));
          if (aria && !/^click to copy layer name$/i.test(aria) && aria.length <= 160) return aria;
        }
      }
      return undefined;
    });

    return rightPanelName ?? this.readSelectedLayerName();
  }

  private isCanvasDiscoveryNoise(name: string): boolean {
    const normalized = name.replace(/\s+/g, " ").trim();
    return /^(registration(?:\s+darkmode)?|pointer|top|container|properties(?:\s+properties)?|screen label(?:\b|$)|section label(?:\b|$))$/i.test(
      normalized,
    );
  }

  private shouldClimbCanvasSelection(name: string): boolean {
    const normalized = normalizeLayerNameForCanvas(name);
    if (!normalized) return false;
    return (
      Boolean(skipReasonForFrameCandidate({ name: normalized })) ||
      /^(inputfield|input field|arrow|content|icons?|image|avatar|button|label|text|title|subtitle|status bar|home indicator|checkbox|radio|divider|rectangle|vector|group(?:\s+\d+)?|untitled design\b)/i.test(
        normalized,
      )
    );
  }

  private shouldRejectCanvasSelection(name: string): boolean {
    const normalized = normalizeLayerNameForCanvas(name);
    if (!normalized) return false;
    return /^(inputfield|input field|arrow|content|icons?|image|avatar|button|label|text|title|subtitle|status bar|home indicator|checkbox|radio|divider|rectangle|vector|group(?:\s+\d+)?|untitled design\b)$/i.test(
      normalized,
    ) || /^\d+$/i.test(normalized);
  }

  private async prepareExportSetting(format: ExportFormat): Promise<void> {
    await this.page.keyboard.press(process.platform === "darwin" ? "Meta+Alt+I" : "Control+Alt+I").catch(() => undefined);
    await this.page.waitForTimeout(Math.min(this.cooldownMs, 1000));

    const addClicked = await this.clickFirstVisible(this.config.selectors.addExportButtons, 2500);
    if (addClicked) {
      await this.page.waitForTimeout(this.cooldownMs);
    }

    await this.trySetExportFormat(format);
  }

  private async trySetExportFormat(format: ExportFormat): Promise<void> {
    const formatPattern = /png|jpg|jpeg|svg|pdf/i;
    const formatButtons = this.page
      .locator('button, [role="button"], [aria-haspopup="listbox"], [role="combobox"]')
      .filter({ hasText: formatPattern });

    const count = await formatButtons.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const button = formatButtons.nth(index);
      if (!(await button.isVisible().catch(() => false))) continue;
      await button.click({ timeout: 2500 }).catch(() => undefined);
      await this.page.waitForTimeout(500);
      const option = this.page.getByText(new RegExp(`^${format}$`, "i")).last();
      if (await option.isVisible().catch(() => false)) {
        await option.click({ timeout: 2500 }).catch(() => undefined);
      }
      return;
    }
  }

  private async findVisibleExportButton() {
    for (const selector of this.config.selectors.exportButtons) {
      const locator = this.page.locator(selector).last();
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    const roleButton = this.page.getByRole("button", { name: /export/i }).last();
    if (await roleButton.isVisible().catch(() => false)) return roleButton;
    return null;
  }

  private async clickFirstVisible(selectors: string[], timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const selector of selectors) {
        const locator = this.page.locator(selector).first();
        if (await locator.isVisible().catch(() => false)) {
          await locator.click({ timeout: 2500 }).catch(() => undefined);
          return true;
        }
      }
      await this.page.waitForTimeout(250);
    }
    return false;
  }

  private async zoomToSelection(): Promise<void> {
    await this.page.keyboard.press("Shift+2").catch(() => undefined);
    await this.page.waitForTimeout(Math.max(this.cooldownMs, 1800));
  }

  private async clearSelectionForCleanCapture(): Promise<void> {
    await this.moveMouseAwayFromCanvasTargets();
    await this.page.keyboard.press("Escape").catch(() => undefined);
    await this.page.waitForTimeout(120);
    await this.page.keyboard.press("Escape").catch(() => undefined);
    await this.moveMouseAwayFromCanvasTargets();
    await this.page.waitForTimeout(Math.max(500, Math.min(this.cooldownMs, 1000)));
  }

  private async moveMouseAwayFromCanvasTargets(): Promise<void> {
    const viewport = this.page.viewportSize();
    const fallbackWidth = viewport?.width ?? 1280;
    const fallbackHeight = viewport?.height ?? 720;
    const box = await this.visibleCanvasSearchBox().catch(() => undefined);
    const x = Math.round((box?.x ?? 0) + (box?.width ?? fallbackWidth) - 8);
    const y = Math.round((box?.y ?? 0) + 8);
    const safeX = clamp(x, 1, fallbackWidth - 2);
    const safeY = clamp(y, 1, fallbackHeight - 2);
    await this.page.mouse.move(safeX, safeY, { steps: 6 }).catch(() => undefined);
    await this.page.waitForTimeout(120);
  }

  private async hideFigmaUiForCapture(): Promise<boolean> {
    await this.ensureBrowserEvalHelpers();
    const uiVisible = await this.page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll("button,[role='button'],[aria-label]"))
        .filter((element) => {
          const html = element as HTMLElement;
          return Boolean(html.offsetWidth || html.offsetHeight || html.getClientRects().length);
        })
        .map((element) =>
          [
            element.getAttribute("aria-label"),
            element.getAttribute("data-tooltip"),
            (element as HTMLElement).innerText,
            element.textContent,
          ]
            .filter(Boolean)
            .join(" "),
        )
        .join(" ");
      return /\b(Main menu|Layers|Inspect|Share|Plugins|Pages)\b/i.test(labels);
    });
    if (!uiVisible) return false;
    await this.page.keyboard.press(process.platform === "darwin" ? "Meta+\\" : "Control+\\").catch(() => undefined);
    await this.page.waitForTimeout(Math.max(1000, this.cooldownMs));
    return true;
  }

  private async showFigmaUiAfterCapture(): Promise<void> {
    await this.page.keyboard.press(process.platform === "darwin" ? "Meta+\\" : "Control+\\").catch(() => undefined);
    await this.page.waitForTimeout(Math.max(800, this.cooldownMs));
  }

  private async visibleCanvasSearchBox(): Promise<CropBox | undefined> {
    await this.ensureBrowserEvalHelpers();
    return this.page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      if (!canvas) return undefined;
      const rect = canvas.getBoundingClientRect();
      const x = Math.max(0, rect.x);
      const y = Math.max(0, rect.y);
      const width = Math.min(window.innerWidth - x, rect.width);
      const height = Math.min(window.innerHeight - y, rect.height);
      if (width < 100 || height < 100) return undefined;
      return { x, y, width, height };
    });
  }

  private async clickLayerRowByName(name: string, layerKind?: string, occurrence = 1): Promise<boolean> {
    await this.ensureBrowserEvalHelpers();
    return this.page.evaluate(
      async ({ targetName, targetKind, targetOccurrence }) => {
        function clean(value: string | null | undefined): string {
          return (value ?? "").replace(/\s+/g, " ").trim();
        }

        function rowInfo(row: Element) {
          const icons = Array.from(row.querySelectorAll("[role='img'], [aria-label]"))
            .map((element) => clean(element.getAttribute("aria-label") || element.getAttribute("data-tooltip")))
            .filter(Boolean);
          const className = String((row as HTMLElement).className);
          const rawName = clean((row as HTMLElement).innerText || row.textContent);
          return {
            name: /dev_handoff_nodes_panel--item/i.test(className)
              ? clean(rawName.replace(/\s+(?:Edited|Created)\b.*$/i, ""))
              : rawName,
            kind: /dev_handoff_nodes_panel--item/i.test(className)
              ? "Ready for development"
              : icons.find((icon) => /^(Frame|Auto layout|Section|Instance)$/i.test(icon)),
          };
        }

        function isVisible(element: Element): boolean {
          const html = element as HTMLElement;
          return Boolean(html.offsetWidth || html.offsetHeight || html.getClientRects().length);
        }

        function layerRows(): HTMLElement[] {
          return Array.from(document.querySelectorAll<HTMLElement>("button, div[role='button']"))
            .filter((row) => isVisible(row))
            .filter((row) => /layers_row--row|dev_handoff_layers_row--row|dev_handoff_nodes_panel--item/i.test(String(row.className)));
        }

        function findScrollContainer(): HTMLElement | Window {
          const row = layerRows()[0];
          let current = row?.parentElement;
          while (current) {
            if (current.scrollHeight > current.clientHeight + 20) {
              return current;
            }
            current = current.parentElement;
          }
          return window;
        }

        async function settle() {
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        }

        const scroller = findScrollContainer();
        const scrollerElement: HTMLElement | undefined =
          scroller === window ? undefined : (scroller as HTMLElement);
        const max = scrollerElement
          ? Math.max(0, scrollerElement.scrollHeight - scrollerElement.clientHeight)
          : Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        const pageSize = scrollerElement
          ? Math.max(160, scrollerElement.clientHeight)
          : window.innerHeight;
        const original = scrollerElement ? scrollerElement.scrollTop : window.scrollY;

        const seenRows = new WeakSet<HTMLElement>();
        let occurrenceCount = 0;

        for (let top = 0; top <= max + 1; top += Math.max(120, Math.floor(pageSize * 0.75))) {
          if (scrollerElement) scrollerElement.scrollTop = top;
          else window.scrollTo(0, top);
          await settle();
          for (const row of layerRows()) {
            if (seenRows.has(row)) continue;
            seenRows.add(row);
            const info = rowInfo(row);
            if (info.name !== targetName) continue;
            if (targetKind && info.kind !== targetKind) continue;
            occurrenceCount += 1;
            if (occurrenceCount !== targetOccurrence) continue;

            row.scrollIntoView({ block: "center", inline: "nearest" });
            await settle();
            const rect = row.getBoundingClientRect();
            const x = rect.left + Math.min(rect.width / 2, 80);
            const y = rect.top + rect.height / 2;
            row.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
            row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
            row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
            row.click();
            return true;
          }
        }

        if (scrollerElement) scrollerElement.scrollTop = original;
        else window.scrollTo(0, original);
        return false;
      },
      { targetName: name, targetKind: layerKind, targetOccurrence: occurrence },
    );
  }

  private async extractFrameCandidatesFromLayers(maxFrames: number): Promise<CandidateRecord[]> {
    await this.ensureBrowserEvalHelpers();
    const candidates = await this.page.evaluate(async (limit) => {
      type RowCandidate = {
        name: string;
        layerKind?: string;
        occurrence?: number;
        confidence: number;
        reason: string;
      };

      function clean(value: string | null | undefined): string {
        return (value ?? "").replace(/\s+/g, " ").trim();
      }

      function isVisible(element: Element): boolean {
        const html = element as HTMLElement;
        return Boolean(html.offsetWidth || html.offsetHeight || html.getClientRects().length);
      }

      function rowInfo(row: HTMLElement): RowCandidate | undefined {
        const className = String(row.className);
        const rawName = clean(row.innerText || row.textContent);
        const name = /dev_handoff_nodes_panel--item/i.test(className)
          ? clean(rawName.replace(/\s+(?:Edited|Created)\b.*$/i, ""))
          : rawName;
        if (!name || name.length > 160) return undefined;
        if (/^(screen label|section label)$/i.test(name)) return undefined;
        if (/dev_handoff_nodes_panel--item/i.test(className)) {
          return {
            name,
            layerKind: "Ready for development",
            confidence: 9,
            reason: "ready-for-development screen item",
          };
        }
        const icons = Array.from(row.querySelectorAll("[role='img'], [aria-label]"))
          .map((element) => clean(element.getAttribute("aria-label") || element.getAttribute("data-tooltip")))
          .filter(Boolean);
        const layerKind = icons.find((icon) => /^(Frame|Auto layout|Section|Instance)$/i.test(icon));
        if (layerKind === "Frame") {
          return { name, layerKind, confidence: 10, reason: "layer icon is Frame" };
        }
        if (layerKind === "Auto layout" && /\b(page|screen|state|modal|dropdown|empty)\b/i.test(name)) {
          return { name, layerKind, confidence: 7, reason: "screen-like auto-layout row" };
        }
        return undefined;
      }

      function rows(): HTMLElement[] {
        return Array.from(document.querySelectorAll<HTMLElement>("button, div[role='button']"))
          .filter((row) => isVisible(row))
          .filter((row) => /layers_row--row|dev_handoff_layers_row--row|dev_handoff_nodes_panel--item/i.test(String(row.className)));
      }

      function findScrollContainer(): HTMLElement | Window {
        const row = rows()[0];
        let current = row?.parentElement;
        while (current) {
          if (current.scrollHeight > current.clientHeight + 20) {
            return current;
          }
          current = current.parentElement;
        }
        return window;
      }

      async function settle() {
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }

      const scroller = findScrollContainer();
      const scrollerElement: HTMLElement | undefined =
        scroller === window ? undefined : (scroller as HTMLElement);
      const original = scrollerElement ? scrollerElement.scrollTop : window.scrollY;
      const max = scrollerElement
        ? Math.max(0, scrollerElement.scrollHeight - scrollerElement.clientHeight)
        : Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const pageSize = scrollerElement ? Math.max(160, scrollerElement.clientHeight) : window.innerHeight;
      const seenRows = new WeakSet<HTMLElement>();
      const occurrenceCounts = new Map<string, number>();
      const found: RowCandidate[] = [];

      for (let top = 0; top <= max + 1 && found.length < limit; top += Math.max(120, Math.floor(pageSize * 0.75))) {
        if (scrollerElement) scrollerElement.scrollTop = top;
        else window.scrollTo(0, top);
        await settle();
        for (const row of rows()) {
          if (seenRows.has(row)) continue;
          seenRows.add(row);
          const candidate = rowInfo(row);
          if (!candidate) continue;
          const key = `${candidate.layerKind ?? ""}:${candidate.name}`;
          const occurrence = (occurrenceCounts.get(key) ?? 0) + 1;
          occurrenceCounts.set(key, occurrence);
          found.push({ ...candidate, occurrence });
          if (found.length >= limit) break;
        }
      }

      if (scrollerElement) scrollerElement.scrollTop = original;
      else window.scrollTo(0, original);

      return found.map((candidate, index) => ({
        candidateId: index,
        name: candidate.name,
        layerKind: candidate.layerKind,
        confidence: candidate.confidence,
        reason: candidate.reason,
      }));
    }, maxFrames);

    const filtered = candidates.filter((candidate) => !skipReasonForFrameCandidate(candidate));
    const skipped = candidates.length - filtered.length;
    const skippedSuffix = skipped > 0 ? ` (${skipped} feedback-learned noise candidate(s) skipped)` : "";
    this.logger(`Discovered ${filtered.length} frame candidate(s) from the Figma Layers UI${skippedSuffix}.`);
    return filtered;
  }

  private async extractCandidates(kind: "frame" | "asset"): Promise<CandidateRecord[]> {
    await this.ensureBrowserEvalHelpers();
    const candidates = await this.page.evaluate(
      ({ kind: requestedKind, layerSelectors }) => {
        function clean(value: string | null | undefined): string {
          return (value ?? "").replace(/\s+/g, " ").trim();
        }

        function assetKindFor(text: string): AssetKind | undefined {
          if (/\b(svg|vector|icon|path|shape|boolean|union|subtract|outline)\b/i.test(text)) return "svg";
          if (/\b(image|bitmap|photo|png|jpe?g|webp|gif|avatar|cover|hero)\b/i.test(text)) {
            return "rendered-image";
          }
          return undefined;
        }

        const selector = layerSelectors.join(",");
        const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
        const ranked: Array<{ element: HTMLElement; candidate: BrowserCandidate }> = [];

        for (const element of elements) {
          const rect = element.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 8) continue;
          const text = clean(element.innerText || element.textContent);
          const aria = clean(element.getAttribute("aria-label"));
          const testId = clean(element.getAttribute("data-testid"));
          const title = clean(element.getAttribute("title"));
          const combined = clean([aria, text, title, testId, element.className.toString()].join(" "));
          const name = text || aria || title;
          if (!name || name.length > 160) continue;

          if (requestedKind === "frame") {
            let confidence = 0;
            const reasons: string[] = [];
            if (/\bframe\b/i.test(combined)) {
              confidence += 8;
              reasons.push("mentions frame");
            }
            if (/\bscreen\b|\bdesktop\b|\bmobile\b|\btablet\b|\bpage\b/i.test(name)) {
              confidence += 2;
              reasons.push("screen-like name");
            }
            if (/\blayer\b|\btreeitem\b/i.test(combined)) {
              confidence += 1;
              reasons.push("layer row");
            }
            if (confidence >= 8) {
              ranked.push({
                element,
                candidate: {
                  candidateId: 0,
                  name,
                  confidence,
                  reason: reasons.join(", "),
                },
              });
            }
            continue;
          }

          const assetKind = assetKindFor(combined);
          if (!assetKind) continue;
          ranked.push({
            element,
            candidate: {
              candidateId: 0,
              name,
              kind: assetKind,
              confidence: assetKind === "svg" ? 7 : 6,
              reason: assetKind === "svg" ? "vector-like layer name" : "image-like layer name",
            },
          });
        }

        ranked.sort((a, b) => b.candidate.confidence - a.candidate.confidence);
        window.__figmaBrowserExporterCandidates = ranked.map((entry) => entry.element);
        return ranked.map((entry, index) => ({
          ...entry.candidate,
          candidateId: index,
        }));
      },
      { kind, layerSelectors: this.config.selectors.layerRows },
    );

    this.logger(`Discovered ${candidates.length} ${kind} candidate(s) from the visible Figma UI.`);
    return candidates;
  }

  private async ensureBrowserEvalHelpers(): Promise<void> {
    await this.page
      .evaluate("globalThis.__name = globalThis.__name || ((value) => value)")
      .catch(() => undefined);
  }

  private async ensureFigmaUiVisible(): Promise<void> {
    await this.ensureBrowserEvalHelpers();
    const visible = await this.page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll("button,[role='button'],[aria-label]"))
        .map((element) =>
          [
            element.getAttribute("aria-label"),
            element.getAttribute("data-tooltip"),
            (element as HTMLElement).innerText,
            element.textContent,
          ]
            .filter(Boolean)
            .join(" "),
        )
        .join(" ");
      return /\b(Main menu|Pages|Layers|Minimize UI)\b/i.test(labels);
    });
    if (visible) return;
    await this.page.keyboard.press(process.platform === "darwin" ? "Meta+\\" : "Control+\\").catch(() => undefined);
    await this.page.waitForTimeout(Math.max(1000, this.cooldownMs));
  }
}

function findCanvasScreenCandidatesInScreenshot(
  screenshot: Buffer,
  maxFrames: number,
): { boardBox: CropBox; candidates: CanvasScreenCandidate[] } {
  const png = PNG.sync.read(screenshot);
  const boardBox = findLeftCanvasBoardBox(png);
  const xStart = clamp(Math.floor(boardBox.x), 0, png.width - 1);
  const yStart = clamp(Math.floor(boardBox.y), 0, png.height - 1);
  const xEnd = clamp(Math.ceil(boardBox.x + boardBox.width), xStart + 1, png.width);
  const yEnd = clamp(Math.ceil(boardBox.y + boardBox.height), yStart + 1, png.height);
  const maskWidth = xEnd - xStart;
  const maskHeight = yEnd - yStart;
  const mask = new Uint8Array(maskWidth * maskHeight);

  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      const offset = (y * png.width + x) * 4;
      const r = png.data[offset];
      const g = png.data[offset + 1];
      const b = png.data[offset + 2];
      const a = png.data[offset + 3];
      if (isCanvasScreenPixel(r, g, b, a)) {
        mask[(y - yStart) * maskWidth + (x - xStart)] = 1;
      }
    }
  }

  const visited = new Uint8Array(mask.length);
  const candidates: CanvasScreenCandidate[] = [];
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || visited[index]) continue;
    const component = floodMask(mask, visited, maskWidth, maskHeight, index);
    const width = component.xMax - component.xMin + 1;
    const height = component.yMax - component.yMin + 1;
    const aspect = width / height;
    if (width < 14 || height < 20 || width > 120 || height > 120) continue;
    if (component.pixels < 45) continue;
    if (aspect < 0.22 || aspect > 2.6) continue;

    candidates.push({
      x: xStart + component.xMin,
      y: yStart + component.yMin,
      width,
      height,
      pixels: component.pixels,
    });
  }

  return {
    boardBox,
    candidates: candidates
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .slice(0, maxFrames),
  };
}

function nearestCanvasCandidate(
  target: CanvasSelectionBox,
  candidates: CanvasScreenCandidate[],
): CanvasScreenCandidate | undefined {
  const targetX = target.x + target.width / 2;
  const targetY = target.y + target.height / 2;
  let best: { candidate: CanvasScreenCandidate; distance: number } | undefined;
  for (const candidate of candidates) {
    const x = candidate.x + candidate.width / 2;
    const y = candidate.y + candidate.height / 2;
    const distance = Math.hypot(x - targetX, y - targetY);
    if (distance > 28) continue;
    if (!best || distance < best.distance) best = { candidate, distance };
  }
  return best?.candidate;
}

function uniqueFramesByNodeId(frames: FrameRecord[]): FrameRecord[] {
  const seen = new Set<string>();
  const result: FrameRecord[] = [];
  for (const frame of frames) {
    if (seen.has(frame.nodeId)) continue;
    seen.add(frame.nodeId);
    result.push(frame);
  }
  return result;
}

function normalizeLayerNameForCanvas(value: string): string {
  return value
    .replace(/\s+(?:Edited|Created)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function selectedLayerNameMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualName = normalizeNameForLooseMatch(actual);
  const expectedName = normalizeNameForLooseMatch(expected);
  if (!actualName || !expectedName) return false;
  return actualName === expectedName || actualName.includes(expectedName) || expectedName.includes(actualName);
}

function normalizeNameForLooseMatch(value: string): string {
  return value
    .replace(/^click to copy layer name:\s*/i, "")
    .replace(/\s+(?:Edited|Created)\b.*$/i, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function findLeftCanvasBoardBox(png: PNG): CropBox {
  const xStart = Math.floor(png.width * 0.12);
  const xEnd = Math.floor(png.width * 0.62);
  const yStart = 0;
  const yEnd = Math.floor(png.height * 0.94);
  const maskWidth = xEnd - xStart;
  const maskHeight = yEnd - yStart;
  const mask = new Uint8Array(maskWidth * maskHeight);

  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      const offset = (y * png.width + x) * 4;
      const r = png.data[offset];
      const g = png.data[offset + 1];
      const b = png.data[offset + 2];
      const a = png.data[offset + 3];
      if (isCanvasBoardBackgroundPixel(r, g, b, a)) {
        mask[(y - yStart) * maskWidth + (x - xStart)] = 1;
      }
    }
  }

  const visited = new Uint8Array(mask.length);
  let best: MaskComponent | undefined;
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || visited[index]) continue;
    const component = floodMask(mask, visited, maskWidth, maskHeight, index);
    const width = component.xMax - component.xMin + 1;
    const height = component.yMax - component.yMin + 1;
    const area = width * height;
    if (width < 220 || height < 300 || component.pixels < 40_000) continue;
    const bestArea = best ? (best.xMax - best.xMin + 1) * (best.yMax - best.yMin + 1) : 0;
    if (!best || component.xMin < best.xMin - 20 || (Math.abs(component.xMin - best.xMin) <= 20 && area > bestArea)) {
      best = component;
    }
  }

  if (!best) {
    return {
      x: Math.floor(png.width * 0.19),
      y: Math.floor(png.height * 0.02),
      width: Math.floor(png.width * 0.31),
      height: Math.floor(png.height * 0.86),
    };
  }

  const padding = 6;
  const x = clamp(xStart + best.xMin - padding, 0, png.width - 1);
  const y = clamp(yStart + best.yMin - padding, 0, png.height - 1);
  const x2 = clamp(xStart + best.xMax + 1 + padding, x + 1, png.width);
  const y2 = clamp(yStart + best.yMax + 1 + padding, y + 1, png.height);
  return { x, y, width: x2 - x, height: y2 - y };
}

function isCanvasBoardBackgroundPixel(r: number, g: number, b: number, a: number): boolean {
  if (a < 180) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const brightness = (r + g + b) / 3;
  return max - min <= 6 && brightness >= 52 && brightness <= 82;
}

function isCanvasScreenPixel(r: number, g: number, b: number, a: number): boolean {
  if (a < 180) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const brightness = (r + g + b) / 3;
  const saturation = max - min;

  if (isCanvasBoardBackgroundPixel(r, g, b, a)) return false;
  if (brightness <= 45 && saturation <= 18) return false;
  if (g >= 205 && r >= 150 && b >= 175 && saturation >= 15 && g - r >= 20) return false;
  if (g >= 145 && r <= 95 && b <= 155) return false;
  if (r >= 200 && g <= 120 && b >= 120) return false;

  return brightness >= 78 || saturation >= 38;
}

function floodMask(
  mask: Uint8Array,
  visited: Uint8Array,
  width: number,
  height: number,
  start: number,
): MaskComponent {
  const queue = [start];
  visited[start] = 1;
  let head = 0;
  let xMin = start % width;
  let xMax = xMin;
  let yMin = Math.floor(start / width);
  let yMax = yMin;
  let pixels = 0;

  while (head < queue.length) {
    const index = queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    pixels += 1;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;

    const neighbors = [
      x > 0 ? index - 1 : -1,
      x < width - 1 ? index + 1 : -1,
      y > 0 ? index - width : -1,
      y < height - 1 ? index + width : -1,
    ];
    for (const neighbor of neighbors) {
      if (neighbor < 0 || visited[neighbor] || !mask[neighbor]) continue;
      visited[neighbor] = 1;
      queue.push(neighbor);
    }
  }

  return { xMin, yMin, xMax, yMax, pixels };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
