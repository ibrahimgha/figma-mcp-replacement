import { describe, expect, it } from "vitest";
import { skipReasonForFrameCandidate, skipReasonForLeftSection } from "../src/frameFilters";

describe("feedback-learned frame filters", () => {
  it("skips left sections that are not app screen sections", () => {
    expect(skipReasonForLeftSection("● Cover")).toBeTruthy();
    expect(skipReasonForLeftSection("■ Overview")).toBeTruthy();
    expect(skipReasonForLeftSection("✅ Home page")).toBeUndefined();
  });

  it("skips rejected utility and label candidates", () => {
    const rejected = [
      "Frame 27",
      "Frame 1171275794",
      "iPhone 13 mini - 1",
      "20548113_6277852 1",
      "Screen Label Created 3 months ago",
      "Section Label Created 3 months ago",
      "Pointer",
      "Top",
      "Container",
    ];

    for (const name of rejected) {
      expect(skipReasonForFrameCandidate({ name })).toBeTruthy();
    }
  });

  it("keeps approved screen-like names", () => {
    const approved = [
      "Home screen",
      "onboarding/1",
      "Registration - light mode - log in",
      "Oz Knowledge/search empty state",
      "Component 1",
      "Tooltips",
    ];

    for (const name of approved) {
      expect(skipReasonForFrameCandidate({ name })).toBeUndefined();
    }
  });
});
