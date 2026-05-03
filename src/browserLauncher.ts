import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
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
      };
    } catch (error) {
      errors.push(`${channel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Could not launch a visible browser.\n${errors.join("\n")}`);
}
