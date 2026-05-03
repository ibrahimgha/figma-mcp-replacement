import { describe, expect, it } from "vitest";
import { dedupeFrames, parseReviewCommand, removeFramesByOneBasedIndexes } from "../src/review";
import type { FrameRecord } from "../src/types";

const frame = (nodeId: string): FrameRecord => ({
  nodeId,
  name: `Frame ${nodeId}`,
  source: "auto",
  url: `https://www.figma.com/design/file/name?node-id=${nodeId.replace(":", "-")}`,
});

describe("review helpers", () => {
  it("parses review commands", () => {
    expect(parseReviewCommand("")).toEqual({ action: "accept" });
    expect(parseReviewCommand("a")).toEqual({ action: "add" });
    expect(parseReviewCommand("r 1, 3")).toEqual({ action: "remove", indexes: [1, 3] });
    expect(parseReviewCommand("q")).toEqual({ action: "cancel" });
  });

  it("dedupes frames by node id", () => {
    expect(dedupeFrames([frame("1:2"), frame("1:2"), frame("2:3")])).toHaveLength(2);
  });

  it("removes one-based indexes", () => {
    expect(removeFramesByOneBasedIndexes([frame("1:2"), frame("2:3")], [2])).toEqual([frame("1:2")]);
  });
});
