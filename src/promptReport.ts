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
    nodeId: entry.manifest.frame.nodeId,
    pageName: entry.manifest.frame.pageName,
    frameUrl: entry.manifest.frame.url,
    frameDir: entry.frameDir,
    screenshot: screenshotPathForEntry(entry),
    manifestPath: path.join(entry.frameDir, "manifest.json"),
    prompt: buildPromptText(entry, index, entries.length),
  }));
  const feedbackScreens = prompts.map((prompt) => ({
    screenOrder: prompt.index + 1,
    pageTitle: prompt.title,
    figmaFrame: prompt.frameName,
    figmaNodeId: prompt.nodeId,
    figmaFrameUrl: prompt.frameUrl,
    figmaPage: prompt.pageName ?? null,
    localScreenDirectory: prompt.frameDir,
    screenshot: prompt.screenshot,
    manifest: prompt.manifestPath,
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
      align-items: start;
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
      overflow: visible;
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
      align-items: flex-start;
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
    .feedback-controls {
      align-items: center;
      border-top: 1px solid #dfe3ea;
      display: flex;
      gap: 8px;
      padding: 10px 12px;
    }
    .feedback-label {
      color: #5f6673;
      font-size: 12px;
      font-weight: 700;
      margin-right: 2px;
      text-transform: uppercase;
    }
    .vote-button {
      background: #ffffff;
      border-color: #cbd3df;
      color: #171a1f;
      margin: 0;
      padding: 6px 10px;
    }
    .vote-button.is-selected[data-vote="approved"] {
      background: #e7f7ec;
      border-color: #239a56;
      color: #17643b;
    }
    .vote-button.is-selected[data-vote="rejected"] {
      background: #fff0ef;
      border-color: #d93025;
      color: #9d2119;
    }
    .vote-status {
      color: #5f6673;
      font-size: 12px;
      margin-left: auto;
      white-space: nowrap;
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
    .feedback-summary {
      background: #ffffff;
      border: 1px solid #dfe3ea;
      border-radius: 8px;
      margin-top: 24px;
      padding: 18px;
    }
    .feedback-summary-header {
      align-items: center;
      display: flex;
      gap: 16px;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .feedback-summary h2 {
      font-size: 18px;
      margin: 0;
    }
    .feedback-help {
      color: #5f6673;
      font-size: 13px;
      margin: 0 0 12px;
    }
    #feedback-message {
      min-height: 280px;
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
      .feedback-controls,
      .feedback-summary-header {
        align-items: stretch;
        display: flex;
        flex-wrap: wrap;
      }
      .vote-status {
        margin-left: 0;
        width: 100%;
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
        (prompt) => `<section class="screen" data-feedback-key="${escapeHtml(feedbackKeyForPrompt(prompt))}">
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
          <div class="feedback-controls">
            <span class="feedback-label">Feedback</span>
            <button type="button" class="vote-button" data-vote="approved" aria-pressed="false">👍 Approve</button>
            <button type="button" class="vote-button" data-vote="rejected" aria-pressed="false">👎 Reject</button>
            <span class="vote-status" data-vote-status>Not reviewed</span>
          </div>
        </div>
        <textarea readonly spellcheck="false">${escapeHtml(prompt.prompt)}</textarea>
      </div>
    </section>`,
      )
      .join("\n")}
    <section class="feedback-summary" id="feedback-summary">
      <div class="feedback-summary-header">
        <h2>Feedback Message</h2>
        <button type="button" data-copy-feedback>Copy feedback</button>
      </div>
      <p class="feedback-help">This message updates after every vote. Paste it back so I can map every approval or rejection to the exact screen, node ID, screenshot, and folder.</p>
      <textarea id="feedback-message" readonly spellcheck="false"></textarea>
    </section>
  </main>
  <script>
    const feedbackScreens = ${jsonForScript(feedbackScreens)};

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

    const feedbackStorageKey = 'figma-browser-export-feedback:' + location.pathname + ':' + feedbackScreens.length;
    const feedbackVotes = loadFeedbackVotes();

    function screenKey(screen) {
      return [
        screen.screenOrder,
        screen.figmaNodeId,
        screen.localScreenDirectory,
      ].join('|');
    }

    function loadFeedbackVotes() {
      try {
        const parsed = JSON.parse(localStorage.getItem(feedbackStorageKey) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    function saveFeedbackVotes() {
      localStorage.setItem(feedbackStorageKey, JSON.stringify(feedbackVotes));
    }

    function feedbackPayload() {
      const screens = feedbackScreens.map((screen) => {
        const vote = feedbackVotes[screenKey(screen)] || 'unreviewed';
        return { vote, ...screen };
      });
      return {
        feedbackSchema: 'figma-browser-export-feedback/v1',
        reportFile: location.href,
        generatedAt: new Date().toISOString(),
        summary: {
          totalScreens: screens.length,
          approved: screens.filter((screen) => screen.vote === 'approved').length,
          rejected: screens.filter((screen) => screen.vote === 'rejected').length,
          unreviewed: screens.filter((screen) => screen.vote === 'unreviewed').length,
        },
        screens,
      };
    }

    function updateFeedbackMessage() {
      const message = document.querySelector('#feedback-message');
      if (message) {
        message.value = JSON.stringify(feedbackPayload(), null, 2);
      }

      document.querySelectorAll('.screen').forEach((section) => {
        const screen = feedbackScreens.find((candidate) => screenKey(candidate) === section.dataset.feedbackKey);
        const vote = screen ? feedbackVotes[screenKey(screen)] : undefined;
        section.querySelectorAll('[data-vote]').forEach((button) => {
          const selected = button.dataset.vote === vote;
          button.classList.toggle('is-selected', selected);
          button.setAttribute('aria-pressed', selected ? 'true' : 'false');
        });
        const status = section.querySelector('[data-vote-status]');
        if (status) {
          status.textContent = vote === 'approved' ? 'Approved' : vote === 'rejected' ? 'Rejected' : 'Not reviewed';
        }
      });
    }

    document.querySelectorAll('[data-vote]').forEach((button) => {
      button.addEventListener('click', () => {
        const section = button.closest('.screen');
        const key = section.dataset.feedbackKey;
        if (feedbackVotes[key] === button.dataset.vote) {
          delete feedbackVotes[key];
        } else {
          feedbackVotes[key] = button.dataset.vote;
        }
        saveFeedbackVotes();
        updateFeedbackMessage();
      });
    });

    const copyFeedbackButton = document.querySelector('[data-copy-feedback]');
    if (copyFeedbackButton) {
      copyFeedbackButton.addEventListener('click', async () => {
        const original = copyFeedbackButton.textContent;
        const message = document.querySelector('#feedback-message');
        try {
          await copyText(message.value);
          copyFeedbackButton.textContent = 'Copied';
          setTimeout(() => {
            copyFeedbackButton.textContent = original;
          }, 1400);
        } catch {
          copyFeedbackButton.textContent = 'Copy failed';
          setTimeout(() => {
            copyFeedbackButton.textContent = original;
          }, 1800);
        }
      });
    }

    document.querySelectorAll('[data-screenshot]').forEach((image) => {
      image.addEventListener('error', () => {
        image.classList.add('is-missing');
      });
    });

    updateFeedbackMessage();
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

function feedbackKeyForPrompt(prompt: { index: number; nodeId: string; frameDir: string }): string {
  return [prompt.index + 1, prompt.nodeId, prompt.frameDir].join("|");
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

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
