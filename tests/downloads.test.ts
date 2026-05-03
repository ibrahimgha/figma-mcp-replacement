import { describe, expect, it } from "vitest";
import { classifyDownloadedFilename, extensionForFormat } from "../src/downloads";

describe("download utilities", () => {
  it("uses expected format extensions when Figma gives no extension", () => {
    expect(classifyDownloadedFilename("Layer", "SVG")).toEqual({
      basename: "Layer",
      extension: ".svg",
    });
  });

  it("maps formats to extensions", () => {
    expect(extensionForFormat("PNG")).toBe(".png");
    expect(extensionForFormat("JPG")).toBe(".jpg");
    expect(extensionForFormat("SVG")).toBe(".svg");
  });
});
