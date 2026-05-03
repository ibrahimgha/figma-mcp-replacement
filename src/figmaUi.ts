import type { Page } from "playwright";
import type { AssetKind, CandidateRecord, FrameRecord } from "./types";
import type { ExporterConfig } from "./config";
import { readNodeIdFromUrl, withNodeId } from "./utils/url";
import { extensionForFormat, saveDownloadAs, type ExportFormat } from "./downloads";

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
    const candidates = await this.extractCandidates("frame");
    const frames: FrameRecord[] = [];
    for (const candidate of candidates.slice(0, maxFrames)) {
      const selected = await this.clickCandidateAndReadSelection(candidate);
      if (!selected?.nodeId) continue;
      frames.push({
        nodeId: selected.nodeId,
        name: selected.name || candidate.name,
        source: "auto",
        url: withNodeId(this.page.url(), selected.nodeId),
      });
    }
    return frames;
  }

  async discoverAssetCandidates(maxAssets: number): Promise<CandidateRecord[]> {
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

  async selectNode(figmaUrl: string, nodeId: string): Promise<void> {
    await this.page.goto(withNodeId(figmaUrl, nodeId), { waitUntil: "domcontentloaded" });
    await this.page.waitForTimeout(this.cooldownMs);
  }

  async readSelectedLayerName(): Promise<string | undefined> {
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

  private async extractCandidates(kind: "frame" | "asset"): Promise<CandidateRecord[]> {
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
}
