import { describe, expect, it } from "vitest";
import {
  appendMissingRequiredKnownFrames,
  OZ_MOBILE_REGISTRATION_REQUIRED_SCREENS,
  requiredKnownFramesForUrl,
} from "../src/knownScreens";
import type { FrameRecord } from "../src/types";

const registrationBoardUrl =
  "https://www.figma.com/design/7HszZb9F00XXRAAR9LGIVr/OZ-Mobile-App?node-id=415-634&p=f";

describe("known Registration board screen anchors", () => {
  it("tracks the full light Registration board close to the expected 44 screens", () => {
    expect(OZ_MOBILE_REGISTRATION_REQUIRED_SCREENS.length).toBeGreaterThanOrEqual(44);
    expect(OZ_MOBILE_REGISTRATION_REQUIRED_SCREENS.length).toBeLessThanOrEqual(46);
    expect(OZ_MOBILE_REGISTRATION_REQUIRED_SCREENS.map((screen) => screen.nodeId)).toEqual([
      "2255:4732",
      "433:4056",
      "433:5749",
      "433:5958",
      "469:1090",
      "1746:36440",
      "469:12126",
      "1711:73147",
      "469:13119",
      "469:14248",
      "469:14336",
      "2008:31009",
      "509:16534",
      "509:17116",
      "509:19354",
      "1695:71973",
      "2255:4962",
      "509:19647",
      "1695:72316",
      "509:19822",
      "1695:72468",
      "3026:47100",
      "509:19936",
      "1695:72183",
      "544:21107",
      "1695:72245",
      "2008:30661",
      "2774:16032",
      "2774:16460",
      "2774:16486",
      "2774:16573",
      "2774:16661",
      "2774:16755",
      "2774:16838",
      "2774:16921",
      "2774:17004",
      "2774:17092",
      "2774:17175",
      "2774:17258",
      "2774:17341",
      "2774:17349",
      "2774:17378",
      "2774:17407",
      "2774:17436",
      "2774:17465",
    ]);
  });

  it("adds missing required screens without duplicating live discoveries", () => {
    const liveFrames: FrameRecord[] = [
      frame("2774:17341", "Registration - light mode - sign up / onboarding /loding"),
      frame("2774:17436", "Registration - light mode - sign up / onboarding /Results/focuser"),
    ];

    const result = appendMissingRequiredKnownFrames(registrationBoardUrl, liveFrames);

    expect(result.added.map((screen) => screen.nodeId)).not.toContain("2774:17341");
    expect(result.added.map((screen) => screen.nodeId)).not.toContain("2774:17436");
    expect(result.added.map((screen) => screen.nodeId)).toContain("2255:4732");
    expect(result.added.map((screen) => screen.nodeId)).toContain("1711:73147");
    expect(result.added.map((screen) => screen.nodeId)).toContain("2774:17378");
    expect(result.frames).toHaveLength(OZ_MOBILE_REGISTRATION_REQUIRED_SCREENS.length);
    expect(new Set(result.frames.map((screen) => screen.nodeId)).size).toBe(result.frames.length);
  });

  it("does not add Registration-board anchors to unrelated Figma URLs", () => {
    const otherUrl = "https://www.figma.com/design/other-file/OZ-Mobile-App?node-id=415-634&p=f";
    expect(requiredKnownFramesForUrl(otherUrl)).toEqual([]);
    expect(appendMissingRequiredKnownFrames(otherUrl, []).frames).toEqual([]);
  });
});

function frame(nodeId: string, name: string): FrameRecord {
  return {
    nodeId,
    name,
    source: "auto",
    url: `https://www.figma.com/design/7HszZb9F00XXRAAR9LGIVr/OZ-Mobile-App?node-id=${nodeId.replace(/:/g, "-")}&p=f`,
    preCapturedScreenshot: `C:\\tmp\\${nodeId.replace(/:/g, "-")}.png`,
  };
}
