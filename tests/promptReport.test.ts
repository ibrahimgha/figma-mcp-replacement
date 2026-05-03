import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPromptText, inferPageTitle, renderPromptHtml } from "../src/promptReport";
import type { Manifest } from "../src/types";

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    sourceUrl: "https://www.figma.com/design/file/name",
    runStartedAt: "2026-05-03T00:00:00.000Z",
    browser: {
      requested: "chrome",
      channel: "chrome",
      profileDir: "C:\\profile",
      downloadsDir: "C:\\downloads",
    },
    frame: {
      nodeId: "1:2",
      name: "Checkout",
      source: "auto",
      url: "https://www.figma.com/design/file/name?node-id=1-2",
    },
    screenshot: "screenshot.png",
    assets: [],
    errors: [],
    ...overrides,
  };
}

describe("prompt report", () => {
  it("uses page title when available", () => {
    expect(
      inferPageTitle(
        manifest({
          frame: {
            nodeId: "1:2",
            name: "Frame 1",
            pageName: "Billing",
            source: "auto",
            url: "https://www.figma.com/design/file/name?node-id=1-2",
          },
        }),
      ),
    ).toBe("Billing");
  });

  it("falls back when no title is useful", () => {
    expect(
      inferPageTitle(
        manifest({
          frame: {
            nodeId: "1:2",
            name: "Frame 1",
            source: "auto",
            url: "https://www.figma.com/design/file/name?node-id=1-2",
          },
        }),
      ),
    ).toBe("Detect what that page is");
  });

  it("includes local directories, screenshot, and assets in prompt text", () => {
    const frameDir = "C:\\exports\\file\\Checkout__1-2";
    const prompt = buildPromptText(
      {
        frameDir,
        manifest: manifest({
          assets: [
            {
              nodeId: "3:4",
              name: "Logo",
              kind: "svg",
              file: "assets/logo.svg",
              status: "exported",
            },
          ],
        }),
      },
      0,
      1,
    );

    expect(prompt).toContain("Page title: Checkout");
    expect(prompt).toContain(`Local screen directory: ${frameDir}`);
    expect(prompt).toContain(`Screenshot: ${path.join(frameDir, "screenshot.png")}`);
    expect(prompt).toContain(`Assets directory: ${path.join(frameDir, "assets")}`);
    expect(prompt).toContain(path.join(frameDir, "assets/logo.svg"));
  });

  it("renders copy buttons sequentially in the html", () => {
    const html = renderPromptHtml([
      { frameDir: "C:\\one", manifest: manifest() },
      {
        frameDir: "C:\\two",
        manifest: manifest({
          frame: {
            nodeId: "5:6",
            name: "Settings",
            source: "auto",
            url: "https://www.figma.com/design/file/name?node-id=5-6",
          },
        }),
      },
    ]);

    expect(html).toContain("1. Checkout");
    expect(html).toContain("2. Settings");
    expect(html.match(/<button[^>]+data-copy-button/g)).toHaveLength(2);
  });

  it("renders a screenshot image for every prompt", () => {
    const html = renderPromptHtml([
      { frameDir: "C:\\one", manifest: manifest() },
      {
        frameDir: "C:\\two",
        manifest: manifest({
          screenshot: undefined,
          frame: {
            nodeId: "5:6",
            name: "Settings",
            source: "auto",
            url: "https://www.figma.com/design/file/name?node-id=5-6",
          },
        }),
      },
    ]);

    expect(html.match(/data-screenshot/g)).toHaveLength(3);
    expect(html.match(/<img[^>]+data-screenshot/g)).toHaveLength(2);
    expect(html).toContain("C:\\two\\screenshot.png");
  });
});
