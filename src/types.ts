export type BrowserChoice = "chrome" | "edge" | "chromium";
export type FrameSource = "auto" | "manual";
export type AssetKind = "rendered-image" | "svg";
export type AssetStatus = "exported" | "skipped" | "failed";
export type AssetMode = "auto" | "manual" | "none";
export type ScreenshotMode = "auto" | "native" | "canvas";

export interface LeftSectionRecord {
  name: string;
  source: "pages-panel";
}

export interface FrameRecord {
  nodeId: string;
  name: string;
  pageName?: string;
  source: FrameSource;
  url: string;
}

export interface AssetRecord {
  nodeId: string;
  name: string;
  kind: AssetKind;
  file?: string;
  status: AssetStatus;
  reason?: string;
}

export interface CandidateRecord {
  candidateId: number;
  name: string;
  kind?: AssetKind;
  layerKind?: string;
  nodeId?: string;
  confidence: number;
  reason: string;
}

export interface ExporterOptions {
  figmaUrl: string;
  outDir: string;
  browser: BrowserChoice;
  cooldownMs: number;
  downloadTimeoutMs: number;
  exportScale: string;
  profileDir?: string;
  assetMode: AssetMode;
  screenshotMode: ScreenshotMode;
  allowFigmaWrites: boolean;
  maxAutoFrames: number;
  maxAssetsPerFrame: number;
  keepBrowserOpen: boolean;
  skipReadyPrompt: boolean;
  useUrlNode: boolean;
  allLeftSections: boolean;
  maxLeftSections: number;
  skipFrameReview: boolean;
  frameName?: string;
}

export interface BrowserSessionInfo {
  requested: BrowserChoice;
  channel: "chrome" | "msedge" | "chromium";
  profileDir: string;
  downloadsDir: string;
}

export interface Manifest {
  sourceUrl: string;
  runStartedAt: string;
  runFinishedAt?: string;
  browser: BrowserSessionInfo;
  frame: FrameRecord;
  screenshot?: string;
  assets: AssetRecord[];
  errors: string[];
}
