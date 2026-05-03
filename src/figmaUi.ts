import type { Page } from "playwright";
import type { AssetKind, CandidateRecord, FrameRecord } from "./types";
import type { ExporterConfig } from "./config";
import { readNodeIdFromUrl, withNodeId } from "./utils/url";
import { extensionForFormat, saveDownloadAs, type ExportFormat } from "./downloads";
import { writeFile } from "node:fs/promises";
import { cropPng, findFigmaSelectionCrop, findLargestForegroundCrop, type CropBox } from "./imageCrop";

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
    const frames: FrameRecord[] = [];
    for (const candidate of candidates) {
      const selected = await this.clickFrameCandidateAndReadSelection(candidate);
      if (!selected?.nodeId) continue;
      frames.push({
        nodeId: selected.nodeId,
        name: candidate.name || selected.name,
        source: "auto",
        url: withNodeId(this.page.url(), selected.nodeId),
      });
    }
    return frames;
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
    const clicked = await this.clickLayerRowByName(candidate.name, candidate.layerKind);
    if (!clicked) return this.clickCandidateAndReadSelection(candidate);
    await this.page.waitForTimeout(this.cooldownMs);
    return {
      nodeId: readNodeIdFromUrl(this.page.url()),
      name: candidate.name,
    };
  }

  async selectNode(figmaUrl: string, nodeId: string): Promise<void> {
    await this.page.goto(withNodeId(figmaUrl, nodeId), { waitUntil: "domcontentloaded" });
    await this.page.waitForTimeout(this.cooldownMs);
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
      await this.zoomToSelection();
      const canvasBox = await this.visibleCanvasSearchBox();
      const screenshot = await this.page.screenshot({ fullPage: false });
      const crop =
        findLargestForegroundCrop(screenshot, canvasBox) ??
        findFigmaSelectionCrop(screenshot, canvasBox);
      if (!crop) {
        throw new Error("Could not detect the selected frame outline in the Figma viewport.");
      }
      await writeFile(targetPath, cropPng(screenshot, crop));
      return targetPath;
    } finally {
      if (didHideUi) await this.showFigmaUiAfterCapture();
    }
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

  private async clickLayerRowByName(name: string, layerKind?: string): Promise<boolean> {
    await this.ensureBrowserEvalHelpers();
    return this.page.evaluate(
      async ({ targetName, targetKind }) => {
        function clean(value: string | null | undefined): string {
          return (value ?? "").replace(/\s+/g, " ").trim();
        }

        function rowInfo(row: Element) {
          const icons = Array.from(row.querySelectorAll("[role='img'], [aria-label]"))
            .map((element) => clean(element.getAttribute("aria-label") || element.getAttribute("data-tooltip")))
            .filter(Boolean);
          return {
            name: clean((row as HTMLElement).innerText || row.textContent),
            kind: icons.find((icon) => /^(Frame|Auto layout|Section|Instance)$/i.test(icon)),
          };
        }

        function isVisible(element: Element): boolean {
          const html = element as HTMLElement;
          return Boolean(html.offsetWidth || html.offsetHeight || html.getClientRects().length);
        }

        function layerRows(): HTMLElement[] {
          return Array.from(document.querySelectorAll<HTMLElement>("div[role='button']"))
            .filter((row) => isVisible(row))
            .filter((row) => /layers_row--row|dev_handoff_layers_row--row/i.test(String(row.className)));
        }

        function findScrollContainer(): HTMLElement | Window {
          const row = layerRows()[0];
          let current = row?.parentElement;
          while (current) {
            const style = window.getComputedStyle(current);
            if (
              current.scrollHeight > current.clientHeight + 20 &&
              !/hidden/i.test(style.overflowY)
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

        for (let top = 0; top <= max + 1; top += Math.max(120, Math.floor(pageSize * 0.75))) {
          if (scrollerElement) scrollerElement.scrollTop = top;
          else window.scrollTo(0, top);
          await settle();
          const match = layerRows().find((row) => {
            const info = rowInfo(row);
            if (info.name !== targetName) return false;
            if (targetKind && info.kind !== targetKind) return false;
            return true;
          });
          if (match) {
            match.scrollIntoView({ block: "center", inline: "nearest" });
            await settle();
            const rect = match.getBoundingClientRect();
            const x = rect.left + Math.min(rect.width / 2, 80);
            const y = rect.top + rect.height / 2;
            match.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
            match.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
            match.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
            match.click();
            return true;
          }
        }

        if (scrollerElement) scrollerElement.scrollTop = original;
        else window.scrollTo(0, original);
        return false;
      },
      { targetName: name, targetKind: layerKind },
    );
  }

  private async extractFrameCandidatesFromLayers(maxFrames: number): Promise<CandidateRecord[]> {
    await this.ensureBrowserEvalHelpers();
    const candidates = await this.page.evaluate(async (limit) => {
      type RowCandidate = {
        name: string;
        layerKind?: string;
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
        const name = clean(row.innerText || row.textContent);
        if (!name || name.length > 160) return undefined;
        if (/^(screen label|section label)$/i.test(name)) return undefined;
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
        return Array.from(document.querySelectorAll<HTMLElement>("div[role='button']"))
          .filter((row) => isVisible(row))
          .filter((row) => /layers_row--row|dev_handoff_layers_row--row/i.test(String(row.className)));
      }

      function findScrollContainer(): HTMLElement | Window {
        const row = rows()[0];
        let current = row?.parentElement;
        while (current) {
          const style = window.getComputedStyle(current);
          if (
            current.scrollHeight > current.clientHeight + 20 &&
            !/hidden/i.test(style.overflowY)
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

      const scroller = findScrollContainer();
      const scrollerElement: HTMLElement | undefined =
        scroller === window ? undefined : (scroller as HTMLElement);
      const original = scrollerElement ? scrollerElement.scrollTop : window.scrollY;
      const max = scrollerElement
        ? Math.max(0, scrollerElement.scrollHeight - scrollerElement.clientHeight)
        : Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const pageSize = scrollerElement ? Math.max(160, scrollerElement.clientHeight) : window.innerHeight;
      const seen = new Set<string>();
      const found: RowCandidate[] = [];

      for (let top = 0; top <= max + 1 && found.length < limit; top += Math.max(120, Math.floor(pageSize * 0.75))) {
        if (scrollerElement) scrollerElement.scrollTop = top;
        else window.scrollTo(0, top);
        await settle();
        for (const row of rows()) {
          const candidate = rowInfo(row);
          if (!candidate) continue;
          const key = `${candidate.layerKind}:${candidate.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          found.push(candidate);
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

    this.logger(`Discovered ${candidates.length} frame candidate(s) from the Figma Layers UI.`);
    return candidates;
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
}
