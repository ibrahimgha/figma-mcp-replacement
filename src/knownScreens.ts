import type { FrameRecord } from "./types";
import { parseFigmaUrl, withNodeId } from "./utils/url";

export const OZ_MOBILE_REGISTRATION_BOARD_FILE_KEY = "7HszZb9F00XXRAAR9LGIVr";
export const OZ_MOBILE_REGISTRATION_BOARD_NODE_ID = "415:634";

export const OZ_MOBILE_REGISTRATION_REQUIRED_RESULT_SCREENS = [
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
] as const;

export function requiredKnownFramesForUrl(figmaUrl: string): FrameRecord[] {
  const parsed = parseFigmaUrl(figmaUrl);
  if (
    parsed.fileKey !== OZ_MOBILE_REGISTRATION_BOARD_FILE_KEY ||
    parsed.nodeId !== OZ_MOBILE_REGISTRATION_BOARD_NODE_ID
  ) {
    return [];
  }

  return OZ_MOBILE_REGISTRATION_REQUIRED_RESULT_SCREENS.map((screen) => ({
    nodeId: screen.nodeId,
    name: screen.name,
    source: "manual",
    url: withNodeId(figmaUrl, screen.nodeId),
  }));
}

export function appendMissingRequiredKnownFrames(
  figmaUrl: string,
  frames: FrameRecord[],
): { frames: FrameRecord[]; added: FrameRecord[] } {
  const knownFrames = requiredKnownFramesForUrl(figmaUrl);
  if (knownFrames.length === 0) return { frames, added: [] };

  const seen = new Set(frames.map((frame) => frame.nodeId));
  const added = knownFrames.filter((frame) => !seen.has(frame.nodeId));
  return { frames: [...frames, ...added], added };
}
