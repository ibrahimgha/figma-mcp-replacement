import path from "node:path";
import { spawn } from "node:child_process";
import type { Manifest } from "./types";
import { ensureDir } from "./utils/files";
import { writeFile } from "node:fs/promises";

export interface PromptReportEntry {
  frameDir: string;
  manifest: Manifest;
}

export function inferPageTitle(manifest: Manifest): string {
  const candidates = [manifest.frame.pageName, manifest.frame.name]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (!isGenericTitle(candidate, manifest.frame.nodeId)) return candidate;
  }

  return "Detect what that page is";
}

export function buildPromptText(entry: PromptReportEntry, index: number, total: number): string {
  const title = inferPageTitle(entry.manifest);
  const screenshot = entry.manifest.screenshot
    ? path.join(entry.frameDir, entry.manifest.screenshot)
    : path.join(entry.frameDir, "screenshot.png");
  const assetsDir = path.join(entry.frameDir, "assets");
  const exportedAssets = entry.manifest.assets
    .filter((asset) => asset.status === "exported" && asset.file)
    .map((asset) => `- ${asset.kind}: ${asset.name} -> ${path.join(entry.frameDir, asset.file!)}`);

  return [
    "Use this local Figma browser export to recreate the screen.",
    "",
    `Screen order: ${index + 1} of ${total}`,
    `Page title: ${title}`,
    `Figma frame: ${entry.manifest.frame.name}`,
    `Figma node ID: ${entry.manifest.frame.nodeId}`,
    `Local screen directory: ${entry.frameDir}`,
    `Screenshot: ${screenshot}`,
    `Assets directory: ${assetsDir}`,
    "",
    "Available exported assets:",
    exportedAssets.length > 0 ? exportedAssets.join("\n") : "- No exported assets were found. Use the screenshot as the source of truth.",
    "",
    "Instructions:",
    "- Use the screenshot as the visual source of truth.",
    "- Use the local assets directory for images/icons whenever needed.",
    "- Preserve layout, spacing, typography, colors, states, and visible content as closely as possible.",
    '- If the page title says "Detect what that page is", infer the best title from the screenshot and screen content.',
  ].join("\n");
}

export function renderPromptHtml(entries: PromptReportEntry[]): string {
  const prompts = entries.map((entry, index) => ({
    index,
    title: inferPageTitle(entry.manifest),
    frameName: entry.manifest.frame.name,
    frameDir: entry.frameDir,
    screenshot: screenshotPathForEntry(entry),
    prompt: buildPromptText(entry, index, entries.length),
  }));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Figma Screen Prompts</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f6f7f9;
      color: #171a1f;
    }
    body {
      margin: 0;
    }
    main {
      max-width: 1120px;
      margin: 0 auto;
      padding: 32px 24px 56px;
    }
    header {
      margin-bottom: 24px;
    }
    h1 {
      font-size: 28px;
      line-height: 1.2;
      margin: 0 0 8px;
    }
    .meta {
      color: #5f6673;
      margin: 0;
    }
    .screen {
      background: #ffffff;
      border: 1px solid #dfe3ea;
      border-radius: 8px;
      margin: 18px 0;
      overflow: hidden;
    }
    .screen-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 16px 18px;
      border-bottom: 1px solid #e7eaf0;
    }
    h2 {
      font-size: 18px;
      margin: 0 0 4px;
    }
    .frame-dir {
      color: #5f6673;
      font-size: 13px;
      margin: 0;
      overflow-wrap: anywhere;
    }
    button {
      appearance: none;
      border: 1px solid #1f6feb;
      background: #1f6feb;
      color: #ffffff;
      border-radius: 6px;
      cursor: pointer;
      font: inherit;
      font-weight: 600;
      padding: 8px 12px;
      white-space: nowrap;
    }
    button:focus-visible {
      outline: 3px solid #9cc9ff;
      outline-offset: 2px;
    }
    .body {
      display: grid;
      grid-template-columns: minmax(260px, 0.8fr) minmax(320px, 1.2fr);
      gap: 18px;
      padding: 18px;
    }
    .preview {
      background: #eef1f5;
      border: 1px solid #dfe3ea;
      border-radius: 6px;
      min-height: 260px;
      overflow: hidden;
    }
    .preview-header {
      align-items: center;
      background: #ffffff;
      border-bottom: 1px solid #dfe3ea;
      display: flex;
      gap: 10px;
      justify-content: space-between;
      padding: 10px 12px;
    }
    .preview-title {
      font-size: 13px;
      font-weight: 700;
    }
    .preview-path {
      color: #5f6673;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .preview-image {
      align-items: center;
      display: flex;
      justify-content: center;
      min-height: 220px;
    }
    .preview img {
      width: 100%;
      height: auto;
      object-fit: contain;
      object-position: top center;
    }
    .preview img.is-missing {
      display: none;
    }
    .missing-preview {
      align-items: center;
      color: #5f6673;
      display: none;
      justify-content: center;
      padding: 24px;
      text-align: center;
      width: 100%;
    }
    .preview img.is-missing + .missing-preview {
      display: flex;
    }
    textarea {
      box-sizing: border-box;
      width: 100%;
      min-height: 320px;
      resize: vertical;
      border: 1px solid #d3d8e0;
      border-radius: 6px;
      color: #171a1f;
      font: 13px/1.45 "Cascadia Mono", Consolas, monospace;
      padding: 12px;
      white-space: pre;
    }
    @media (max-width: 820px) {
      main {
        padding: 24px 14px 40px;
      }
      .screen-header,
      .body {
        display: block;
      }
      button {
        margin-top: 12px;
      }
      .preview {
        margin-bottom: 14px;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Figma Screen Prompts</h1>
      <p class="meta">${entries.length} screen prompt${entries.length === 1 ? "" : "s"} generated sequentially from local exports.</p>
    </header>
    ${prompts
      .map(
        (prompt) => `<section class="screen">
      <div class="screen-header">
        <div>
          <h2>${prompt.index + 1}. ${escapeHtml(prompt.title)}</h2>
          <p class="frame-dir">${escapeHtml(prompt.frameName)} - ${escapeHtml(prompt.frameDir)}</p>
        </div>
        <button type="button" data-copy-button>Copy prompt</button>
      </div>
      <div class="body">
        <div class="preview">
          <div class="preview-header">
            <span class="preview-title">Screenshot</span>
            <span class="preview-path">${escapeHtml(prompt.screenshot)}</span>
          </div>
          <div class="preview-image">
            <img src="${pathToFileUrl(prompt.screenshot)}" alt="${escapeHtml(prompt.frameName)} screenshot" loading="lazy" data-screenshot>
            <div class="missing-preview">Screenshot not found at ${escapeHtml(prompt.screenshot)}</div>
          </div>
        </div>
        <textarea readonly spellcheck="false">${escapeHtml(prompt.prompt)}</textarea>
      </div>
    </section>`,
      )
      .join("\n")}
  </main>
  <script>
    async function copyText(text) {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
      }
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.setAttribute('readonly', '');
      helper.style.position = 'fixed';
      helper.style.left = '-9999px';
      document.body.appendChild(helper);
      helper.select();
      document.execCommand('copy');
      document.body.removeChild(helper);
    }

    document.querySelectorAll('[data-copy-button]').forEach((button) => {
      button.addEventListener('click', async () => {
        const section = button.closest('.screen');
        const textarea = section.querySelector('textarea');
        const original = button.textContent;
        try {
          await copyText(textarea.value);
          button.textContent = 'Copied';
          setTimeout(() => {
            button.textContent = original;
          }, 1400);
        } catch (error) {
          button.textContent = 'Copy failed';
          setTimeout(() => {
            button.textContent = original;
          }, 1800);
        }
      });
    });

    document.querySelectorAll('[data-screenshot]').forEach((image) => {
      image.addEventListener('error', () => {
        image.classList.add('is-missing');
      });
    });
  </script>
</body>
</html>
`;
}

export async function writePromptReport(outDir: string, entries: PromptReportEntry[]): Promise<string> {
  await ensureDir(outDir);
  const htmlPath = path.join(outDir, "prompts.html");
  await writeFile(htmlPath, renderPromptHtml(entries), "utf8");
  return htmlPath;
}

export function openFileInBrowser(filePath: string): void {
  const absolute = path.resolve(filePath);
  const command =
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", absolute] : [absolute];

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function isGenericTitle(title: string, nodeId: string): boolean {
  const normalized = title.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized === "untitled" ||
    normalized === "frame" ||
    normalized === "screen" ||
    normalized === `frame ${nodeId.toLowerCase()}` ||
    /^frame[\s_-]*\d*$/i.test(title) ||
    /^screen[\s_-]*\d*$/i.test(title) ||
    /^[\d\s:._-]+$/.test(title)
  );
}

function screenshotPathForEntry(entry: PromptReportEntry): string {
  return entry.manifest.screenshot
    ? path.join(entry.frameDir, entry.manifest.screenshot)
    : path.join(entry.frameDir, "screenshot.png");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pathToFileUrl(filePath: string): string {
  const resolved = path.resolve(filePath).replace(/\\/g, "/");
  const prefixed = resolved.startsWith("/") ? resolved : `/${resolved}`;
  return `file://${encodeURI(prefixed)}`;
}
