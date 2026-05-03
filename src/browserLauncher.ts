import path from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { chromium, type Browser, type BrowserContext } from "playwright";
import type { BrowserChoice, BrowserSessionInfo } from "./types";
import { ensureDir } from "./utils/files";

interface LaunchArgs {
  cwd: string;
  browser: BrowserChoice;
  profileDir?: string;
}

interface LaunchResult {
  context: BrowserContext;
  info: BrowserSessionInfo;
  reusedExistingBrowser: boolean;
  close: () => Promise<void>;
  detach: () => Promise<void>;
}

function channelsFor(browser: BrowserChoice): Array<"chrome" | "msedge" | "chromium"> {
  if (browser === "chrome") return ["chrome", "msedge", "chromium"];
  if (browser === "edge") return ["msedge", "chrome", "chromium"];
  return ["chromium", "chrome", "msedge"];
}

export async function launchVisibleBrowser(args: LaunchArgs): Promise<LaunchResult> {
  const profileRoot =
    args.profileDir ?? path.join(args.cwd, ".figma-browser-export", "profile", args.browser);
  const downloadsDir = path.join(args.cwd, ".figma-browser-export", "downloads");
  await ensureDir(profileRoot);
  await ensureDir(downloadsDir);

  const errors: string[] = [];
  for (const channel of channelsFor(args.browser)) {
    const reusable = await launchOrConnectReusableBrowser(channel, profileRoot, downloadsDir);
    if (reusable) {
      return {
        ...reusable,
        info: {
          requested: args.browser,
          channel,
          profileDir: profileRoot,
          downloadsDir,
        },
      };
    }

    try {
      const launchOptions = {
        headless: false,
        acceptDownloads: true,
        downloadsPath: downloadsDir,
        viewport: { width: 1920, height: 1080 },
        args: ["--start-maximized", "--window-size=1920,1080"],
        ...(channel === "chromium" ? {} : { channel }),
      };
      const context = await chromium.launchPersistentContext(profileRoot, launchOptions);
      return {
        context,
        info: {
          requested: args.browser,
          channel,
          profileDir: profileRoot,
          downloadsDir,
        },
        reusedExistingBrowser: false,
        close: () => context.close(),
        detach: () => Promise.resolve(),
      };
    } catch (error) {
      errors.push(`${channel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Could not launch a visible browser.\n${errors.join("\n")}`);
}

async function launchOrConnectReusableBrowser(
  channel: "chrome" | "msedge" | "chromium",
  profileRoot: string,
  downloadsDir: string,
): Promise<Omit<LaunchResult, "info"> | undefined> {
  const port = reusableDebugPort(channel);
  const endpoint = `http://127.0.0.1:${port}`;
  const existing = await connectToReusableBrowser(endpoint, downloadsDir);
  if (existing) return { ...existing, reusedExistingBrowser: true };

  const executable = browserExecutable(channel);
  if (!executable) return undefined;

  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileRoot}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--start-maximized",
    "--window-size=1920,1080",
    "about:blank",
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();

  const launched = await waitForReusableBrowser(endpoint, downloadsDir);
  if (launched) return { ...launched, reusedExistingBrowser: false };
  return undefined;
}

async function waitForReusableBrowser(
  endpoint: string,
  downloadsDir: string,
): Promise<{ context: BrowserContext; close: () => Promise<void>; detach: () => Promise<void> } | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const connected = await connectToReusableBrowser(endpoint, downloadsDir);
    if (connected) return connected;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

async function connectToReusableBrowser(
  endpoint: string,
  downloadsDir: string,
): Promise<{ context: BrowserContext; close: () => Promise<void>; detach: () => Promise<void> } | undefined> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 1500 });
    const context =
      browser.contexts()[0] ??
      (await browser.newContext({
        acceptDownloads: true,
        viewport: { width: 1920, height: 1080 },
      }));
    return {
      context,
      close: () => browser?.close() ?? Promise.resolve(),
      detach: () => browser?.close() ?? Promise.resolve(),
    };
  } catch {
    await browser?.close().catch(() => undefined);
    return undefined;
  }
}

function reusableDebugPort(channel: "chrome" | "msedge" | "chromium"): number {
  if (channel === "chrome") return 9332;
  if (channel === "msedge") return 9333;
  return 9334;
}

function browserExecutable(channel: "chrome" | "msedge" | "chromium"): string | undefined {
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const candidates =
    channel === "chrome"
      ? [
          localAppData ? path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : undefined,
          path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
          path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
        ]
      : channel === "msedge"
        ? [
            localAppData ? path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
            path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
            path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
          ]
        : [chromium.executablePath()];

  return candidates.filter((candidate): candidate is string => Boolean(candidate)).find((candidate) => existsSync(candidate));
}
