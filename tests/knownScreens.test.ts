import { describe, expect, it } from "vitest";
import {
  appendMissingRequiredKnownFrames,
  OZ_MOBILE_REGISTRATION_REQUIRED_RESULT_SCREENS,
  requiredKnownFramesForUrl,
} from "../src/knownScreens";
import type { FrameRecord } from "../src/types";

const registrationBoardUrl =
  "https://www.figma.com/design/7HszZb9F00XXRAAR9LGIVr/OZ-Mobile-App?node-id=415-634&p=f";

describe("known Registration board screen anchors", () => {
  it("tracks the six tricky loading/results screens by exact node ID", () => {
    expect(OZ_MOBILE_REGISTRATION_REQUIRED_RESULT_SCREENS).toEqual([
      {
        nodeId: "2774:17341",
        name: "Registration - light mode - sign up / onboarding /loding",
        expectedScreenText: "Finding your rhythm",
      },
      {
        nodeId: "2774:17349",
        name: "Registration - light mode - sign up / onboarding /Results/BUILDER",
        expectedScreenText: "Builder",
      },
      {
        nodeId: "2774:17378",
        name: "Registration - light mode - sign up / onboarding /Results/connetor",
        expectedScreenText: "Connector",
      },
      {
        nodeId: "2774:17407",
        name: "Registration - light mode - sign up / onboarding /Results/learner",
        expectedScreenText: "Learner",
      },
      {
        nodeId: "2774:17436",
        name: "Registration - light mode - sign up / onboarding /Results/focuser",
        expectedScreenText: "Focuser",
      },
      {
        nodeId: "2774:17465",
        name: "Registration - light mode - sign up / onboarding /Results/explored",
        expectedScreenText: "Explorer",
      },
    ]);
  });

  it("adds missing required screens without duplicating live discoveries", () => {
    const liveFrames: FrameRecord[] = [
      frame("2774:17341", "Registration - light mode - sign up / onboarding /loding"),
      frame("2774:17436", "Registration - light mode - sign up / onboarding /Results/focuser"),
    ];

    const result = appendMissingRequiredKnownFrames(registrationBoardUrl, liveFrames);

    expect(result.added.map((screen) => screen.nodeId)).toEqual([
      "2774:17349",
      "2774:17378",
      "2774:17407",
      "2774:17465",
    ]);
    expect(result.frames.map((screen) => screen.nodeId)).toEqual([
      "2774:17341",
      "2774:17436",
      "2774:17349",
      "2774:17378",
      "2774:17407",
      "2774:17465",
    ]);
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
