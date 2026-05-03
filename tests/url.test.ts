import { describe, expect, it } from "vitest";
import { nodeIdToUrlParam, normalizeNodeId, parseFigmaUrl, withNodeId } from "../src/utils/url";

describe("figma url utilities", () => {
  it("normalizes URL node ids", () => {
    expect(normalizeNodeId("12-34")).toBe("12:34");
    expect(nodeIdToUrlParam("12:34")).toBe("12-34");
  });

  it("parses file key, slug, and selected node", () => {
    const parsed = parseFigmaUrl("https://www.figma.com/design/abc123/My-File?node-id=1-2");
    expect(parsed.fileKey).toBe("abc123");
    expect(parsed.fileSlug).toBe("My-File");
    expect(parsed.nodeId).toBe("1:2");
  });

  it("sets node ids without touching the base URL", () => {
    expect(withNodeId("https://www.figma.com/design/abc123/My-File?m=dev", "9:10")).toContain(
      "node-id=9-10",
    );
  });
});
